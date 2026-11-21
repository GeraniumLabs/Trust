#!/usr/bin/env node
// Scores Trust's memory judge against hand-labeled gold data.
//
//   node eval/score.mjs                 # pairs + tasks against http://localhost:8787
//   BASE_URL=https://trust.example node eval/score.mjs
//   node eval/score.mjs --pairs-only | --tasks-only
//   node eval/score.mjs --label clef-flash   # name used for eval/results/<label>.json
//   node eval/score.mjs --set core | hard    # one pair set only (default: both)
//
// It scores whichever judge the Worker is configured with (TRUST_JUDGE), so the numbers
// reflect exactly what production would do: heuristic, Clef/Clef-Flash on Workers AI,
// or any /v1/systemone endpoint such as a local Kev.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const CONCURRENCY = Number(opt("--concurrency") ?? 4);

const LABELS = ["duplicate", "refines", "supersedes", "contradicts", "unrelated"];
// The bars come from the Worker (GET judge-config), so the scorer applies exactly what it would.
let BARS = null;
const barFor = (j) => (j.judge === "heuristic" ? BARS.fallbackThresholds : BARS.thresholds)[j.relation] ?? 0;
const ACTION = { duplicate: "merge", contradicts: "conflict", supersedes: "supersede", refines: "keep", unrelated: "keep" };

// Space id -> admin token, and session id -> agent token.
const ADMIN = {};
const TOKENS = {};
const AGENT_ACTIONS = /\/(remember|recall|relate|retract)$/;
function tokenFor(method, path, body) {
  const space = path.split("/")[2];
  if (method === "POST" && AGENT_ACTIONS.test(path)) return TOKENS[body?.session];
  return ADMIN[space];
}

async function api(method, path, body) {
  const token = tokenFor(method, path, body);
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ""}`);
  if (data.adminToken && data.demo) ADMIN[data.demo] = data.adminToken;
  if (data.token && data.id) TOKENS[data.id] = data.token;
  return data;
}
const newDemo = async () => (await api("POST", "/demo")).demo;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---------- pairs ----------

const SETS = { core: "gold/pairs.jsonl", hard: "gold/pairs-hard.jsonl" };

async function scorePairs(file) {
  const pairs = readFileSync(join(here, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // Each demo allows a limited number of operations; start a fresh one every 200 calls.
  let demo = await newDemo();
  let used = 0;
  const results = await pool(pairs, CONCURRENCY, async (p) => {
    if (++used % 200 === 0) demo = await newDemo();
    const t0 = Date.now();
    const [j] = await api("POST", `/demo/${demo}/judge`, { newer: { ...p.newer, sources: p.newer.sources }, older: [{ ...p.older, sources: p.older.sources }] });
    const acted = j.confidence >= barFor(j) ? ACTION[j.relation] : "keep";
    // How far the top answer leads the runner-up: a possible better gate than raw confidence for
    // models that spread probability across all five relations.
    const sorted = Object.values(j.probabilities ?? {}).map(Number).sort((a, b) => b - a);
    const margin = sorted.length > 1 ? Math.round((sorted[0] - sorted[1]) * 10000) / 10000 : null;
    const actionable = ["duplicate", "supersedes", "contradicts"].includes(j.relation);
    // Same rule as the Scope: only judgments Trust didn't act on become notes for the agent.
    const unsureAt = j.judge === "heuristic" ? BARS.fallbackUnsureBelow ?? 0.55 : BARS.unsureBelow;
    const unsure = acted === "keep" && (j.confidence < unsureAt || (actionable && j.confidence < barFor(j)));
    return { id: p.id, domain: p.domain, difficulty: p.difficulty, trap: p.trap ?? null, gold: p.label, pred: j.relation, confidence: j.confidence, judge: j.judge, fallback: j.fallback ?? null, judgeMs: j.ms, roundTripMs: Date.now() - t0, goldAction: ACTION[p.label], action: acted, unsure, margin, probabilities: j.probabilities ?? null };
  });

  const confusion = Object.fromEntries(LABELS.map((g) => [g, Object.fromEntries(LABELS.map((p) => [p, 0]))]));
  for (const r of results) confusion[r.gold][r.pred]++;
  const per = {};
  for (const l of LABELS) {
    const tp = confusion[l][l];
    const fp = LABELS.reduce((s, g) => s + (g !== l ? confusion[g][l] : 0), 0);
    const fn = LABELS.reduce((s, p) => s + (p !== l ? confusion[l][p] : 0), 0);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    per[l] = { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, support: tp + fn };
  }
  const acc = (rs) => (rs.length ? rs.filter((r) => r.gold === r.pred).length / rs.length : 0);
  const by = (k) => Object.fromEntries([...new Set(results.map((r) => r[k]))].sort().map((v) => [v, acc(results.filter((r) => r[k] === v))]));
  const summary = {
    n: results.length,
    judge: [...new Set(results.map((r) => r.judge))].join(", "),
    accuracy: acc(results),
    macroF1: LABELS.reduce((s, l) => s + per[l].f1, 0) / LABELS.length,
    actionAccuracy: results.filter((r) => r.action === r.goldAction).length / results.length,
    // The costly mistakes, in the order they hurt:
    harmfulMerges: results.filter((r) => r.action === "merge" && r.gold !== "duplicate").map((r) => r.id), // folds a different claim into an existing one
    wrongfulSupersedes: results.filter((r) => r.action === "supersede" && r.gold !== "supersedes").map((r) => r.id), // retires a memory that was still true
    missedConflicts: results.filter((r) => r.gold === "contradicts" && r.action !== "conflict").map((r) => r.id), // a disagreement nobody reviews
    falseConflicts: results.filter((r) => r.action === "conflict" && r.gold !== "contradicts").map((r) => r.id), // review noise
    // The unsure band: judgments Trust passes to the agent instead of acting on.
    sentToAgent: results.filter((r) => r.unsure).map((r) => r.id),
    sentToAgentUseful: results.filter((r) => r.unsure && (r.pred !== r.gold || r.action !== r.goldAction)).map((r) => r.id),
    costlyMissesFlagged: results.filter((r) => r.unsure && r.action !== r.goldAction && r.goldAction !== "keep").map((r) => r.id),
    fallbacks: results.filter((r) => r.fallback).length,
    fallbackReasons: [...new Set(results.filter((r) => r.fallback).map((r) => r.fallback))].slice(0, 5),
    byDifficulty: by("difficulty"),
    byDomain: by("domain"),
    byTrap: by("trap"),
    latencyMs: { judgeP50: quantile(results.map((r) => r.judgeMs), 0.5), judgeP95: quantile(results.map((r) => r.judgeMs), 0.95), roundTripP50: quantile(results.map((r) => r.roundTripMs), 0.5) },
  };
  return { summary, perLabel: per, confusion, results };
}

function printPairs({ summary: s, perLabel, confusion }, name) {
  console.log(`\nPairs (${name}): ${s.n} labeled pairs, judge ${s.judge}`);
  console.log(`  accuracy ${pct(s.accuracy)}   macro-F1 ${pct(s.macroF1)}   action accuracy ${pct(s.actionAccuracy)}`);
  console.log(`  by difficulty: ${Object.entries(s.byDifficulty).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
  console.log(`  by domain: ${Object.entries(s.byDomain).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
  const traps = Object.entries(s.byTrap).filter(([k]) => k !== "null");
  if (traps.length) console.log(`  by trap: ${traps.map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
  console.log(`  judge latency p50 ${s.latencyMs.judgeP50} ms, p95 ${s.latencyMs.judgeP95} ms; fallbacks ${s.fallbacks}`);
  if (s.fallbackReasons.length) {
    console.log(`\n  ⚠ ${s.fallbacks} of ${s.n} model calls failed and fell back to the heuristic, so these are mostly heuristic scores:`);
    for (const r of s.fallbackReasons) console.log(`    ${r}`);
  }
  console.log(`\n  ${"label".padEnd(12)} ${"P".padStart(6)} ${"R".padStart(6)} ${"F1".padStart(6)}`);
  for (const [l, m] of Object.entries(perLabel)) console.log(`  ${l.padEnd(12)} ${pct(m.precision).padStart(6)} ${pct(m.recall).padStart(6)} ${pct(m.f1).padStart(6)}`);
  console.log(`\n  confusion (rows gold, columns predicted)`);
  console.log(`  ${"".padEnd(12)} ${LABELS.map((l) => l.slice(0, 5).padStart(6)).join("")}`);
  for (const g of LABELS) console.log(`  ${g.padEnd(12)} ${LABELS.map((p) => String(confusion[g][p]).padStart(6)).join("")}`);
  console.log(`\n  sent to the agent as unsure: ${s.sentToAgent.length} (${s.sentToAgentUseful.length} where the judge was wrong or didn't act)  ${s.sentToAgent.join(" ")}`);
  if (s.costlyMissesFlagged.length) console.log(`    costly misses the agent was told about: ${s.costlyMissesFlagged.join(" ")}`);
  console.log(`\n  costly mistakes`);
  console.log(`    harmful merges      ${s.harmfulMerges.length}  ${s.harmfulMerges.join(" ")}`);
  console.log(`    wrongful supersedes ${s.wrongfulSupersedes.length}  ${s.wrongfulSupersedes.join(" ")}`);
  console.log(`    missed conflicts    ${s.missedConflicts.length}  ${s.missedConflicts.join(" ")}`);
  console.log(`    false conflicts     ${s.falseConflicts.length}  ${s.falseConflicts.join(" ")}`);
}

// ---------- calibration ----------
// For each relation Trust acts on: how the current bar performs, and the lowest bar above which
// every prediction of that relation was right. Wrong merges and supersedes cost the most, so a
// bar is only worth lowering if precision stays at 100%.
function calibrate(results) {
  const out = {};
  for (const rel of ["duplicate", "supersedes", "contradicts"]) {
    const preds = results.filter((r) => r.pred === rel);
    const gold = results.filter((r) => r.gold === rel).length;
    const bar = BARS.thresholds[rel];
    const at = (t) => {
      const acted = preds.filter((r) => r.confidence >= t);
      const right = acted.filter((r) => r.gold === rel).length;
      return { acted: acted.length, precision: acted.length ? right / acted.length : 1, recall: gold ? right / gold : 0 };
    };
    const worstWrong = Math.max(-Infinity, ...preds.filter((r) => r.gold !== rel).map((r) => r.confidence));
    const lowestRight = Math.min(Infinity, ...preds.filter((r) => r.gold === rel).map((r) => r.confidence));
    const safe = Number.isFinite(worstWrong) ? Math.min(1, Math.round((worstWrong + 0.01) * 100) / 100) : Number.isFinite(lowestRight) ? lowestRight : bar;
    const margins = (f) => preds.filter(f).map((r) => r.margin).filter((m) => m != null);
    const rightM = margins((r) => r.gold === rel);
    const wrongM = margins((r) => r.gold !== rel);
    out[rel] = {
      bar, atBar: at(bar), safeBar: safe, atSafe: at(safe),
      wrongAbove: preds.filter((r) => r.gold !== rel).map((r) => `${r.id}@${r.confidence}`),
      // Does the lead over the runner-up separate right from wrong better than confidence?
      margin: rightM.length ? { rightMin: Math.min(...rightM), wrongMax: wrongM.length ? Math.max(...wrongM) : null } : null,
    };
  }
  return out;
}

function printCalibration(c) {
  console.log(`\nCalibration (all pair sets; current bars from the Worker)`);
  for (const [rel, x] of Object.entries(c)) {
    console.log(`  ${rel.padEnd(12)} bar ${x.bar.toFixed(2)}: precision ${pct(x.atBar.precision)}, recall ${pct(x.atBar.recall)}` +
      `   |  every prediction right at ${x.safeBar.toFixed(2)}+ (recall ${pct(x.atSafe.recall)})` +
      (x.wrongAbove.length ? `   wrong: ${x.wrongAbove.join(" ")}` : ""));
    if (x.margin) console.log(`  ${"".padEnd(12)} lead over runner-up: right ones >= ${x.margin.rightMin.toFixed(2)}, wrong ones <= ${x.margin.wrongMax == null ? "none" : x.margin.wrongMax.toFixed(2)}`);
  }
}

// ---------- tasks ----------

async function runTask(task) {
  const demo = await newDemo();
  const sessions = {};
  const session = async (as) =>
    (sessions[as] ??= (await api("POST", `/demo/${demo}/sessions`, { scope: "northwind", agent: `eval-${as}`, supervisor: `eval-supervisor-${as}` })).id);
  const ids = {};
  const merged = {};
  let step = 0;
  for (const s of task.steps) {
    const e = await api("POST", `/demo/${demo}/remember`, { session: await session(s.as), scope: "northwind", title: s.title, body: s.body, sources: s.sources ?? [], step: ++step });
    ids[s.key] = e.id;
    if (e.deduped) merged[s.key] = e.deduped.into;
  }
  const graph = await api("GET", `/demo/${demo}/graph`);
  const nw = graph.graphs.northwind;
  const entries = (nw.entries ?? []).filter(Boolean);
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const keyOf = Object.fromEntries(Object.entries(ids).filter(([k]) => !merged[k]).map(([k, v]) => [v, k]));
  const checks = [];
  const check = (name, ok, got) => checks.push({ name, ok, got });
  const x = task.expect;
  if (x.entries != null) check(`entries = ${x.entries}`, entries.length === x.entries, entries.length);
  for (const [k, into] of Object.entries(x.merged ?? {})) check(`${k} merged into ${into}`, merged[k] === ids[into], merged[k] ?? "not merged");
  for (const [k, st] of Object.entries(x.status ?? {})) check(`${k} is ${st}`, byId[ids[k]]?.status === st, byId[ids[k]]?.status);
  for (const [k, st] of Object.entries(x.notStatus ?? {})) check(`${k} is not ${st}`, byId[ids[k]]?.status !== st, byId[ids[k]]?.status);
  for (const [k, n] of Object.entries(x.sources ?? {})) check(`${k} has ${n} sources`, byId[ids[k]]?.sources?.length === n, byId[ids[k]]?.sources?.length);
  for (const [k, n] of Object.entries(x.corroborations ?? {})) check(`${k} has ${n} corroborations`, (byId[ids[k]]?.corroborations?.length ?? 0) === n, byId[ids[k]]?.corroborations?.length ?? 0);
  if (x.openConflicts != null) {
    const open = (nw.conflicts ?? []).filter((c) => c.status === "open").length;
    check(`${x.openConflicts} open conflicts`, open === x.openConflicts, open);
  }
  for (const r of x.recall ?? []) {
    const out = await api("POST", `/demo/${demo}/recall`, { session: await session(r.as), query: r.query, step: ++step });
    const top = out.results.find((e) => !e.advisory);
    check(`recall "${r.query}" → ${r.top}`, top?.id === ids[r.top], top ? keyOf[top.id] ?? top.id : "nothing");
  }
  return { id: task.id, name: task.name, skill: task.skill, passed: checks.every((c) => c.ok), checks };
}

async function scoreTasks() {
  const { tasks } = JSON.parse(readFileSync(join(here, "gold/tasks.json"), "utf8"));
  const results = [];
  for (const t of tasks) {
    try {
      results.push(await runTask(t));
    } catch (err) {
      results.push({ id: t.id, name: t.name, skill: t.skill, passed: false, checks: [{ name: "ran", ok: false, got: err.message }] });
    }
  }
  const skills = [...new Set(results.map((r) => r.skill))];
  return {
    summary: {
      n: results.length,
      passed: results.filter((r) => r.passed).length,
      checks: results.flatMap((r) => r.checks).length,
      checksPassed: results.flatMap((r) => r.checks).filter((c) => c.ok).length,
      bySkill: Object.fromEntries(skills.map((s) => [s, `${results.filter((r) => r.skill === s && r.passed).length}/${results.filter((r) => r.skill === s).length}`])),
    },
    results,
  };
}

function printTasks({ summary: s, results }) {
  console.log(`\nTasks: ${s.passed}/${s.n} passed (${s.checksPassed}/${s.checks} checks)`);
  console.log(`  by skill: ${Object.entries(s.bySkill).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const r of results) {
    console.log(`  ${r.passed ? "pass" : "FAIL"} ${r.id} ${r.name}`);
    for (const c of r.checks.filter((c) => !c.ok)) console.log(`         ✗ ${c.name} (got ${c.got})`);
  }
}

// ---------- main ----------

const report = { base: BASE, at: new Date().toISOString() };
if (!flag("--tasks-only")) {
  const demo = await newDemo();
  BARS = await api("GET", `/demo/${demo}/judge-config`);
  report.bars = BARS;
  BARS.unsureBelow ??= 0.55;
  if (BARS.warning) {
    console.log(`\n⚠ ${BARS.warning}\n`);
    if (!flag("--allow-heuristic")) {
      console.log("Stopping so this isn't saved as a model run. Fix the setting, or pass --allow-heuristic to score anyway.");
      process.exit(1);
    }
  }
  console.log(`Judge ${BARS.judge}${BARS.second ? ` (second opinion ${BARS.second})` : ""}; unsure below ${BARS.unsureBelow}; bars ${Object.entries(BARS.thresholds).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const sets = opt("--set") ? [opt("--set")] : Object.keys(SETS);
  const all = [];
  for (const name of sets) {
    const r = await scorePairs(SETS[name]);
    report[name === "core" ? "pairs" : `pairs_${name}`] = r;
    printPairs(r, name);
    all.push(...r.results);
  }
  report.calibration = calibrate(all);
  printCalibration(report.calibration);
}
if (!flag("--pairs-only")) {
  report.tasks = await scoreTasks();
  printTasks(report.tasks);
}
const label = opt("--label") ?? (BARS?.judge ?? "run").replace(/[^a-z0-9.-]+/gi, "-");
mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${label}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\nWrote ${file}`);
