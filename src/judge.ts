// Judge: decides how a new memory relates to memories already in the scope.
//
//   duplicate    same claim; the new one adds nothing a reader would act on differently
//   refines      consistent with the older one and adds detail, scope, or an exception
//   supersedes   the older one was true before; the new one says it has changed
//   contradicts  both describe the same current state and cannot both be true
//   unrelated    different subject, even if the wording overlaps
//
// Backends:
//   heuristic    word overlap + negation + change markers. No network, always available.
//   workers-ai   Clef or Clef-Flash through the Workers AI binding (env.AI).
//   systemone    any /v1/systemone endpoint by base URL: local Kev via Ollama or llama.cpp,
//                hosted Jev, OpenRouter, LiteLLM, ...
//
// Every model call has a timeout and falls back to the heuristic, so a slow or failed model
// never blocks a write. Each judgment records which judge produced it.

export type Relation = "duplicate" | "refines" | "supersedes" | "contradicts" | "unrelated";
export const RELATIONS: Relation[] = ["duplicate", "refines", "supersedes", "contradicts", "unrelated"];

export interface MemoryText {
  title: string;
  body: string;
  sources?: string[];
  kind?: string;
}

export interface Judgment {
  relation: Relation;
  confidence: number;
  probabilities: Record<Relation, number>;
  judge: string; // e.g. "heuristic", "workers-ai:clef-flash", "systemone:kev-4b"
  fallback?: string; // why a model judgment fell back to the heuristic
  ms: number;
}

export interface Judge {
  name: string;
  judge(newer: MemoryText, older: MemoryText[]): Promise<Judgment[]>;
}

export interface JudgeEnv {
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  TRUST_JUDGE?: string; // auto | heuristic | workers-ai | systemone
  TRUST_JUDGE_MODEL?: string; // "@cf/cloudflare/clef-flash", "kev-4b", "jev", ...
  TRUST_JUDGE_URL?: string; // base URL for systemone, e.g. http://localhost:11434
  TRUST_JUDGE_KEY?: string; // bearer token for systemone (a secret)
  TRUST_JUDGE_TIMEOUT_MS?: string;
  // Override the bars a judgment must clear before Trust acts on it. JSON, either flat for all
  // model judges, {"duplicate":0.8}, or keyed by judge name, {"systemone:jev-latest":{"supersedes":0.75}}.
  TRUST_JUDGE_THRESHOLDS?: string;
}

// ---------- thresholds ----------
// A judgment changes nothing unless its confidence clears the bar for its relation.
// Duplicates have the highest bar: a merge folds one write into another, the costliest mistake.
// Supersedes is next: retiring a memory that is still true. The defaults come from the first Jev
// run (eval/results/jev.json): every correct supersede scored 0.80+, and two real contradictions
// scored 0.62 and 0.74, so contradicts stays at 0.5. Each model should be re-checked against its
// own eval run; `node eval/score.mjs` prints a suggested bar per relation.
export type Thresholds = Record<"duplicate" | "contradicts" | "supersedes" | "refines", number>;
export const MODEL_THRESHOLDS: Thresholds = { duplicate: 0.75, contradicts: 0.5, supersedes: 0.7, refines: 0.5 };
// The heuristic's confidences are fixed constants, not probabilities, so it keeps its own bars.
export const HEURISTIC_THRESHOLDS: Thresholds = { duplicate: 0.75, contradicts: 0.5, supersedes: 0.5, refines: 0.5 };

export function thresholdsFor(judge: string, env: Pick<JudgeEnv, "TRUST_JUDGE_THRESHOLDS"> = {}): Thresholds {
  if (judge === "heuristic") return HEURISTIC_THRESHOLDS;
  let over: Record<string, unknown> = {};
  try {
    over = env.TRUST_JUDGE_THRESHOLDS ? JSON.parse(env.TRUST_JUDGE_THRESHOLDS) : {};
  } catch {
    over = {}; // a malformed override never blocks writes
  }
  const flat = Object.fromEntries(Object.entries(over).filter(([, v]) => typeof v === "number"));
  const keyed = (over[judge] && typeof over[judge] === "object" ? over[judge] : {}) as Record<string, number>;
  const out = { ...MODEL_THRESHOLDS, ...flat, ...keyed } as Thresholds;
  for (const k of Object.keys(out) as (keyof Thresholds)[]) if (typeof out[k] !== "number" || out[k] < 0 || out[k] > 1) out[k] = MODEL_THRESHOLDS[k];
  return out;
}

// ---------- heuristic ----------

const NEGATION = /\b(not|never|don['’]?t|do not|avoid|no longer|stop|shouldn['’]?t|must not|isn['’]?t|aren['’]?t|won['’]?t|cannot|can['’]?t)\b/i;
// Words that mark a change over time. Generic on purpose: "instead of" is left out because it
// usually states a preference, not a change.
const CHANGE = /\b(now|replaced|replacing|renamed|moved|migrated|switched|changed|as of|since v?\d|no longer|deprecated|upgraded|from now on|going forward|retired|removed|raised|reduced|lowered|increased|dropped|amended|extended|substituted|became|starting)\b/i;
const STOP = new Set("the and for with from that this into when then than are was were has have use using via its our all any also just only every each per".split(" "));
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export const words = (t: string) =>
  new Set((t.toLowerCase().replace(/['’]s\b/g, "").match(/[a-z0-9_.()]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
export const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
};
// Share of the smaller memory's words found in the other one. Short memories need this:
// Jaccard punishes them for every extra word in the longer one.
const containment = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.max(1, Math.min(a.size, b.size));
};
const numbers = (t: string) => new Set(t.toLowerCase().match(/(?<![a-z])\d+(?:[.,:]\d+)*/g) ?? []); // skips "p50", "v2"

const onehot = (r: Relation, c: number): Record<Relation, number> => {
  const rest = (1 - c) / (RELATIONS.length - 1);
  return Object.fromEntries(RELATIONS.map((x) => [x, x === r ? c : rest])) as Record<Relation, number>;
};

export function heuristicRelation(newer: MemoryText, older: MemoryText): { relation: Relation; confidence: number } {
  const nt = `${newer.title} ${newer.body}`;
  const ot = `${older.title} ${older.body}`;
  const nw = words(nt);
  const ow = words(ot);
  const jac = jaccard(nw, ow);
  const con = containment(nw, ow);
  const shared = (newer.sources ?? []).some((s) => (older.sources ?? []).includes(s));
  const related = con >= 0.34 || (shared && con >= 0.2);
  if (!related) return { relation: "unrelated", confidence: Math.min(0.9, 0.6 + (0.34 - con)) };
  if (CHANGE.test(nt) && !CHANGE.test(ot)) return { relation: "supersedes", confidence: 0.55 };
  if (NEGATION.test(nt) !== NEGATION.test(ot)) return { relation: "contradicts", confidence: 0.55 };
  // Same wording around different figures (30 days vs 90 days) is a disagreement, never a duplicate.
  const nn = numbers(nt);
  const on = numbers(ot);
  // A figure from the older memory is gone and a new one took its place. Added figures alone
  // (a refinement adding a p95) don't count.
  if ([...on].some((x) => !nn.has(x)) && [...nn].some((x) => !on.has(x))) return { relation: "contradicts", confidence: 0.55 };
  // The heuristic only clears the merge bar (0.75) on identical text. On the eval sets its other
  // duplicate verdicts were right 29% of the time, and near-duplicates that add one detail are
  // exactly what it can't tell apart, so those are logged at 0.7 and never merged.
  const addsFigure = [...nn].some((x) => !on.has(x)); // new figures are new information
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (norm(nt) === norm(ot)) return { relation: "duplicate", confidence: 0.99 };
  if (!addsFigure && (jac >= 0.5 || (con >= 0.7 && nw.size <= ow.size * 1.3))) return { relation: "duplicate", confidence: 0.7 };
  let covered = 0;
  for (const w of ow) if (nw.has(w)) covered++;
  if (covered / Math.max(1, ow.size) >= 0.5 && (nw.size > ow.size || addsFigure)) return { relation: "refines", confidence: 0.55 };
  return { relation: "unrelated", confidence: 0.45 };
}

export class HeuristicJudge implements Judge {
  name = "heuristic";
  async judge(newer: MemoryText, older: MemoryText[]): Promise<Judgment[]> {
    const t0 = Date.now();
    return older.map((o) => {
      const { relation, confidence } = heuristicRelation(newer, o);
      return { relation, confidence, probabilities: onehot(relation, confidence), judge: this.name, ms: Date.now() - t0 };
    });
  }
}

// ---------- System One ----------

const CRITERIA: Record<Relation, string> = {
  duplicate: "States the same fact or instruction as the existing memory. Rewording or an extra citation does not count as new information.",
  refines: "Agrees with the existing memory and adds detail, scope, a condition, or an exception. Both stay true.",
  supersedes: "Says the existing memory used to be true but has changed: a newer version, a migration, a policy change, or a replacement.",
  contradicts: "Describes the same current situation as the existing memory, but both cannot be true, and nothing says it changed over time.",
  unrelated: "Is about a different subject, even if some words overlap.",
};

const brief = (m: MemoryText) => ({ title: m.title, body: m.body, ...(m.sources?.length ? { sources: m.sources } : {}) });

// One request covers every candidate: state holds the new memory and the existing ones,
// and there is one choice question per existing memory.
export function systemOneRequest(model: string, newer: MemoryText, older: MemoryText[]) {
  const existing: Record<string, unknown> = {};
  const questions: Record<string, unknown> = {};
  older.slice(0, 64).forEach((o, i) => {
    existing[`m${i}`] = brief(o);
    questions[`rel_m${i}`] = {
      type: "choice",
      instructions: `How does new_memory relate to existing.m${i}?`,
      criteria: CRITERIA,
    };
  });
  return {
    model,
    state: {
      task: "An AI agent wants to save new_memory to a shared memory store. Compare it with each existing memory.",
      new_memory: brief(newer),
      existing,
    },
    questions,
  };
}

export function parseSystemOne(resp: any, n: number, judge: string, ms: number): Judgment[] {
  const answers = resp?.answers ?? resp?.result?.answers;
  if (!answers) throw new Error("no answers in response");
  return Array.from({ length: n }, (_, i) => {
    const a = answers[`rel_m${i}`];
    if (!a || !RELATIONS.includes(a.choice)) throw new Error(`missing or invalid answer rel_m${i}`);
    const probabilities = Object.fromEntries(RELATIONS.map((r) => [r, Number(a.probabilities?.[r] ?? (r === a.choice ? 1 : 0))])) as Record<Relation, number>;
    return { relation: a.choice as Relation, confidence: Number(a.confidence ?? probabilities[a.choice as Relation]), probabilities, judge, ms };
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
};

abstract class ModelJudge implements Judge {
  abstract name: string;
  constructor(protected timeoutMs: number, private fallback = new HeuristicJudge()) {}
  protected abstract call(body: unknown): Promise<unknown>;
  protected abstract selector(): string;
  async judge(newer: MemoryText, older: MemoryText[]): Promise<Judgment[]> {
    if (!older.length) return [];
    const t0 = Date.now();
    try {
      const resp = await withTimeout(this.call(systemOneRequest(this.selector(), newer, older)), this.timeoutMs);
      return parseSystemOne(resp, Math.min(older.length, 64), this.name, Date.now() - t0);
    } catch (err) {
      const reason = `${this.name} failed: ${(err as Error).message}`;
      return (await this.fallback.judge(newer, older)).map((j) => ({ ...j, fallback: reason }));
    }
  }
}

export class WorkersAIJudge extends ModelJudge {
  name: string;
  constructor(private ai: NonNullable<JudgeEnv["AI"]>, private model = "@cf/cloudflare/clef-flash", timeoutMs = 1500) {
    super(timeoutMs);
    this.name = `workers-ai:${this.selector()}`;
  }
  protected selector() {
    return this.model.split("/").pop()!; // "@cf/cloudflare/clef-flash" -> "clef-flash"
  }
  protected call(body: unknown) {
    return this.ai.run(this.model, body);
  }
}

export class SystemOneJudge extends ModelJudge {
  name: string;
  constructor(private baseUrl: string, private model: string, private key?: string, timeoutMs = 5000) {
    super(timeoutMs);
    this.name = `systemone:${model}`;
  }
  protected selector() {
    return this.model;
  }
  protected async call(body: unknown) {
    const url = `${this.baseUrl.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "")}/v1/systemone`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify(body),
    });
    // Keep the start of the error body: providers name the bad field or model there.
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return r.json();
  }
}

// auto: Clef-Flash when the Workers AI binding exists, otherwise a System One URL if set,
// otherwise the heuristic.
export function makeJudge(env: JudgeEnv): Judge {
  const mode = (env.TRUST_JUDGE || "auto").toLowerCase();
  const timeout = env.TRUST_JUDGE_TIMEOUT_MS ? Number(env.TRUST_JUDGE_TIMEOUT_MS) : undefined;
  if (mode === "heuristic") return new HeuristicJudge();
  if ((mode === "workers-ai" || mode === "auto") && env.AI) return new WorkersAIJudge(env.AI, env.TRUST_JUDGE_MODEL || "@cf/cloudflare/clef-flash", timeout ?? 1500);
  if ((mode === "systemone" || mode === "auto") && env.TRUST_JUDGE_URL) return new SystemOneJudge(env.TRUST_JUDGE_URL, env.TRUST_JUDGE_MODEL || "kev-4b", env.TRUST_JUDGE_KEY, timeout ?? 5000);
  return new HeuristicJudge();
}
