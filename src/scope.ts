// Scope: one Durable Object per scope (a matter, a project, or the firm precedent library).
// Its SQLite database is the source of truth: current entries, an append-only version
// history, sources with content hashes, derivation links, and recall receipts.

import { DurableObject } from "cloudflare:workers";
import type { Corroboration, Derivation, Entry, RememberInput, SourceRef, Status, TrustTier, UnsureNote } from "./types";
import { isUnsure, makeJudge, makeSecondJudge, resolveJudge, RELATIONS, thresholdsFor, unsureBelow, type Judge, type JudgeEnv, type Judgment, type MemoryText, type Relation, type Thresholds } from "./judge";

const TTL_MS = 60 * 60 * 1000;
const TRUST_WEIGHT: Record<TrustTier, number> = { reviewed: 3, sourced: 2, unverified: 1 };
// Flagged entries are still recalled, but ranked below clean ones and labeled.
const STATUS_PENALTY: Record<string, number> = { active: 0, contested: 1.5, stale: 1.5, superseded: 2.5 };
const TRUST_RANK: Record<TrustTier, number> = { unverified: 0, sourced: 1, reviewed: 2 };

const NEIGHBOURS = 5;

interface ScopeEnv extends JudgeEnv {
  TRUST_SIGNING_KEY?: string;
}

export class Scope extends DurableObject<ScopeEnv> {
  private ready = false;
  private fts = false;
  private judgeImpl: Judge | null = null;
  private secondImpl: Judge | null | undefined;

  private get judge(): Judge {
    return (this.judgeImpl ??= makeJudge(this.env));
  }

  private get second(): Judge | null {
    if (this.secondImpl === undefined) this.secondImpl = makeSecondJudge(this.env);
    return this.secondImpl;
  }

  private init() {
    if (this.ready) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, kind TEXT, title TEXT, body TEXT, status TEXT, trust TEXT, derivation TEXT,
      origin_agent TEXT, origin_session TEXT, origin_supervisor TEXT, origin_step INTEGER,
      version INTEGER, created_at INTEGER, updated_at INTEGER, signature TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, a TEXT, b TEXT, reason TEXT, status TEXT, resolution TEXT, reviewer TEXT, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entry_versions (id TEXT, version INTEGER, status TEXT, body TEXT, actor TEXT, note TEXT, at INTEGER, PRIMARY KEY (id, version))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, uri TEXT, hash TEXT, kind TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entry_sources (entry TEXT, source TEXT, PRIMARY KEY (entry, source))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entry_parents (entry TEXT, parent TEXT, PRIMARY KEY (entry, parent))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS receipts (n INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT, version INTEGER, session TEXT, step INTEGER, rank INTEGER, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, from_ref TEXT, title TEXT, original TEXT, proposed TEXT, removed TEXT, status TEXT, reviewer TEXT, entry TEXT, at INTEGER)`);
    // Every judgment the judge made on a write, kept for audit and for calibrating thresholds.
    sql.exec(`CREATE TABLE IF NOT EXISTS relations (n INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT, relation TEXT, confidence REAL, judge TEXT, fallback TEXT, ms INTEGER, action TEXT, at INTEGER)`);
    // A write judged to duplicate an existing entry: its origin and sources, kept on that entry.
    sql.exec(`CREATE TABLE IF NOT EXISTS corroborations (n INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT, agent TEXT, session TEXT, supervisor TEXT, step INTEGER, sources TEXT, judge TEXT, confidence REAL, at INTEGER)`);
    // Pairs the judge wasn't sure about. No action was taken; the agent was told and decides.
    sql.exec(`CREATE TABLE IF NOT EXISTS unsure (id TEXT PRIMARY KEY, entry TEXT, other TEXT, first_rel TEXT, first_conf REAL, first_judge TEXT, second_rel TEXT, second_conf REAL, second_judge TEXT, status TEXT, decided_by TEXT, decision TEXT, at INTEGER)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS receipts_entry ON receipts (entry)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS entries_session ON entries (origin_session)`);
    try {
      sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, title, body)`);
      this.fts = true;
    } catch {
      this.fts = false; // fall back to LIKE matching
    }
    this.ready = true;
  }

  private next(key: string): number {
    const sql = this.ctx.storage.sql;
    const row = sql.exec(`SELECT v FROM meta WHERE k = ?`, key).toArray()[0];
    const n = row ? Number(row.v) + 1 : 1;
    sql.exec(`INSERT OR REPLACE INTO meta VALUES (?, ?)`, key, String(n));
    return n;
  }

  // Demo scopes delete themselves an hour after their first write; persistent ones never do.
  private async touchTtl() {
    this.init();
    const persistent = (this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = 'persistent'`).toArray()[0] as any)?.v === "1";
    if (!persistent && (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  async setPersistent() {
    this.init();
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta VALUES ('persistent', '1')`);
    await this.ctx.storage.deleteAlarm();
  }

  async destroy() {
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }

  // ---------- writes ----------

  async remember(prefix: string, input: RememberInput): Promise<Entry> {
    this.init();
    if (!input.origin?.session || !input.origin?.agent) throw new Error("Rejected: a memory needs an origin");
    if (!input.title?.trim() || !input.body?.trim()) throw new Error("Rejected: title and body are required");
    const sql = this.ctx.storage.sql;
    const parents = (input.parents ?? []).filter((p) => sql.exec(`SELECT 1 FROM entries WHERE id = ?`, p).toArray().length);
    const sources = input.sources ?? [];
    // No sources: stored, but capped at the lowest trust tier.
    const trust: TrustTier = input.derivation === "promoted" ? "reviewed" : sources.length || parents.length ? "sourced" : "unverified";
    const kind = input.kind ?? "learning";

    // Judge the write against its nearest neighbours before storing it.
    const candidates = this.neighbours(`${input.title} ${input.body}`, kind, parents);
    const judgments = candidates.length ? await this.judge.judge(this.asText({ title: input.title, body: input.body, sources: sources.map((s) => s.uri), kind }), candidates.map((c) => this.asText(c))) : [];
    const pairs = candidates.map((c, i) => ({ c, j: judgments[i] })).filter((p) => p.j);
    const best = (rel: string, f: (c: Entry) => boolean = () => true) =>
      pairs.filter((p) => p.j.relation === rel && this.clears(p.j, rel) && f(p.c)).sort((a, b) => b.j.confidence - a.j.confidence)[0];

    // 1. Duplicate of an active entry: fold this write in as corroboration instead of a new entry.
    const dup = best("duplicate", (c) => c.status === "active");
    if (dup) {
      // The merged write has no id of its own; its judgments are logged against the entry it joined.
      this.recordRelations(`merged:${dup.c.id}`, pairs, new Map([[dup.c.id, "merged"]]));
      const merged = await this.corroborate(dup.c.id, input, trust, dup.j);
      const notes = await this.noteUnsure(dup.c.id, input, pairs.filter((p) => p.c.id !== dup.c.id));
      return { ...merged, deduped: { into: dup.c.id, judge: dup.j.judge, confidence: dup.j.confidence }, unsure: notes };
    }

    const id = `${prefix}-${this.next("entry")}`;
    const now = Date.now();
    const o = input.origin;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO entries VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        id, kind, input.title, input.body, trust, input.derivation ?? "observed",
        o.agent, o.session, o.supervisor, o.step ?? 0, now, now,
      );
      sql.exec(`INSERT INTO entry_versions VALUES (?, 1, 'active', ?, ?, 'remembered', ?)`, id, input.body, o.agent, now);
      for (const s of sources) {
        const sid = `${s.uri}@${s.hash ?? "unhashed"}`;
        sql.exec(`INSERT OR IGNORE INTO sources VALUES (?, ?, ?, ?)`, sid, s.uri, s.hash ?? null, s.kind ?? "file");
        sql.exec(`INSERT OR IGNORE INTO entry_sources VALUES (?, ?)`, id, sid);
      }
      for (const p of parents) sql.exec(`INSERT OR IGNORE INTO entry_parents VALUES (?, ?)`, id, p);
      if (this.fts) sql.exec(`INSERT INTO entries_fts (id, title, body) VALUES (?, ?, ?)`, id, input.title, input.body);
    });
    // Attestation: sign the entry with its origin and the exact source versions it cites.
    const signature = await this.sign(this.get(id)!);
    sql.exec(`UPDATE entries SET signature = ? WHERE id = ?`, signature, id);

    // 2. Contradiction with another session's memory: both become contested and go to review.
    const actions = new Map<string, string>();
    const clash = best("contradicts", (c) => c.origin.session !== o.session);
    if (clash) {
      this.openConflict(clash.c.id, id, this.reasonFor(clash.j, "contradicts"));
      actions.set(clash.c.id, "conflict");
    }
    // 3. Supersedes: the older entry steps aside, unless it carries more trust than this write.
    //    A lower-trust write cannot retire a higher-trust memory on its own; that goes to review.
    const supersedes = pairs
      .filter((p) => p.j.relation === "supersedes" && this.clears(p.j, "supersedes") && !actions.has(p.c.id) && p.c.status !== "contested")
      .sort((a, b) => b.j.confidence - a.j.confidence || TRUST_RANK[b.c.trust as TrustTier] - TRUST_RANK[a.c.trust as TrustTier]);
    for (const p of supersedes) {
      if (TRUST_RANK[trust] >= TRUST_RANK[p.c.trust as TrustTier]) {
        this.setStatus([p.c.id], "superseded", "judge", `superseded by ${id} (${p.j.judge}, ${p.j.confidence.toFixed(2)})`);
        actions.set(p.c.id, "superseded");
      } else if (!clash) {
        this.openConflict(p.c.id, id, `claims to supersede a ${p.c.trust} memory but is only ${trust} (${p.j.judge}, ${p.j.confidence.toFixed(2)})`);
        actions.set(p.c.id, "conflict");
        break;
      }
    }
    this.recordRelations(id, pairs, actions);
    const notes = await this.noteUnsure(id, input, pairs.filter((p) => !actions.has(p.c.id)));
    await this.touchTtl();
    return { ...this.get(id)!, unsure: notes };
  }

  // Unsure pairs: no action. Ask the second model, if one is configured, and record both readings
  // for the agent. A second model can be as confidently wrong as the first, so it never acts.
  private async noteUnsure(entry: string, input: RememberInput, pairs: { c: Entry; j: Judgment }[]): Promise<UnsureNote[]> {
    const unsure = pairs.filter((p) => isUnsure(p.j, this.env)).slice(0, 3);
    if (!unsure.length) return [];
    let seconds: (Judgment | null)[] = unsure.map(() => null);
    if (this.second) {
      const out = await this.second.judge(this.asText({ title: input.title, body: input.body, sources: (input.sources ?? []).map((s) => s.uri) }), unsure.map((p) => this.asText(p.c)));
      seconds = unsure.map((_, i) => (out[i] && !out[i].fallback ? out[i] : null)); // a failed second opinion is reported as none
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    return unsure.map((p, i) => {
      const nid = `u-${this.next("unsure")}`;
      const s2 = seconds[i];
      sql.exec(`INSERT INTO unsure VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
        nid, entry, p.c.id, p.j.relation, p.j.confidence, p.j.judge, s2?.relation ?? null, s2?.confidence ?? null, s2?.judge ?? null, now);
      return {
        id: nid, entry, with: p.c.id, with_title: p.c.title,
        first: { relation: p.j.relation, confidence: p.j.confidence, judge: p.j.judge },
        second: s2 ? { relation: s2.relation, confidence: s2.confidence, judge: s2.judge } : null,
        status: "open" as const,
      };
    });
  }

  // The agent's decision on a pair, usually one the judge was unsure about. Applied with the same
  // rules as a confident judge: a contradiction opens a review, a supersede respects trust tiers,
  // a duplicate folds the newer memory into the older one as corroboration.
  async relate(entry: string, other: string, relation: Relation, agent: string, note: string) {
    this.init();
    if (!RELATIONS.includes(relation)) throw new Error(`relation must be one of ${RELATIONS.join(", ")}`);
    if (entry === other) throw new Error("a memory can't relate to itself");
    const a = this.get(entry);
    const b = this.get(other);
    if (!a || !b) throw new Error("both memories must exist in this scope");
    const by = `agent:${agent}`;
    const why = `${agent} judged ${relation}${note ? `: ${note}` : ""}`;
    let action = "logged";
    if (relation === "contradicts") {
      this.openConflict(other, entry, why);
      action = "conflict";
    } else if (relation === "supersedes") {
      if (TRUST_RANK[a.trust] >= TRUST_RANK[b.trust]) {
        this.setStatus([other], "superseded", by, `superseded by ${entry} (${why})`);
        action = "superseded";
      } else {
        this.openConflict(other, entry, `claims to supersede a ${b.trust} memory but is only ${a.trust} (${why})`);
        action = "conflict";
      }
    } else if (relation === "duplicate") {
      await this.corroborate(other, { title: a.title, body: a.body, sources: a.sources.map((s) => ({ uri: s.uri, hash: s.hash ?? undefined, kind: s.kind })), origin: a.origin, kind: a.kind } as RememberInput,
        a.trust, { relation, confidence: 1, probabilities: {} as Judgment["probabilities"], judge: by, ms: 0 });
      this.setStatus([entry], "retracted", by, `merged into ${other} as a duplicate (${why})`);
      action = "merged";
    }
    const sql = this.ctx.storage.sql;
    sql.exec(`INSERT INTO relations (a, b, relation, confidence, judge, fallback, ms, action, at) VALUES (?, ?, ?, 1, ?, NULL, 0, ?, ?)`, entry, other, relation, by, action, Date.now());
    sql.exec(`UPDATE unsure SET status = 'decided', decided_by = ?, decision = ? WHERE status = 'open' AND ((entry = ? AND other = ?) OR (entry = ? AND other = ?))`, by, relation, entry, other, other, entry);
    await this.touchTtl();
    return { action, entry: this.get(entry), other: this.get(other) };
  }

  private unsureFor(id: string): UnsureNote[] {
    return (this.ctx.storage.sql.exec(`SELECT * FROM unsure WHERE status = 'open' AND (entry = ? OR other = ?) ORDER BY at`, id, id).toArray() as any[]).map((u) => ({
      id: u.id, entry: u.entry, with: u.other,
      first: { relation: u.first_rel, confidence: u.first_conf, judge: u.first_judge },
      second: u.second_rel ? { relation: u.second_rel, confidence: u.second_conf, judge: u.second_judge } : null,
      status: u.status, decision: u.decision,
    }));
  }

  // Bars come from the judge that actually produced the judgment, so a model call that fell
  // back to the heuristic is held to the heuristic's bars.
  private clears(j: Judgment, rel: string) {
    return j.confidence >= (thresholdsFor(j.judge, this.env)[rel as keyof Thresholds] ?? 1);
  }

  async judgeConfig() {
    const judge = this.judge.name;
    const { requested, warning } = resolveJudge(this.env);
    return { judge, requested, warning, thresholds: thresholdsFor(judge, this.env), fallbackThresholds: thresholdsFor("heuristic"), unsureBelow: unsureBelow(this.env, judge), fallbackUnsureBelow: unsureBelow(this.env, "heuristic"), second: this.second?.name ?? null };
  }

  // Nearest neighbours of a new write: same kind, still live, not its own parents.
  private neighbours(text: string, kind: string, parents: string[]): Entry[] {
    const sql = this.ctx.storage.sql;
    const terms = [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2))].slice(0, 40);
    let ids: string[] = [];
    if (terms.length && this.fts) {
      try {
        ids = sql
          .exec(`SELECT id FROM entries_fts WHERE entries_fts MATCH ? ORDER BY bm25(entries_fts) LIMIT 25`, terms.map((t) => `"${t}"`).join(" OR "))
          .toArray()
          .map((r: any) => r.id as string);
      } catch {
        ids = [];
      }
    }
    if (!ids.length) {
      ids = (sql.exec(`SELECT id, title, body FROM entries`).toArray() as any[])
        .map((r) => ({ id: r.id as string, n: terms.filter((t) => `${r.title} ${r.body}`.toLowerCase().includes(t)).length }))
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n)
        .map((r) => r.id);
    }
    return ids
      .map((id) => this.get(id)!)
      .filter((e) => e && e.kind === kind && ["active", "stale", "contested"].includes(e.status) && !parents.includes(e.id))
      .slice(0, NEIGHBOURS);
  }

  private asText(e: { title: string; body: string; sources?: (SourceRef | string)[]; kind?: string }): MemoryText {
    return { title: e.title, body: e.body, sources: (e.sources ?? []).map((s) => (typeof s === "string" ? s : s.uri)), kind: e.kind };
  }

  private reasonFor(j: Judgment, rel: string) {
    return `${j.judge} judged ${rel} (${j.confidence.toFixed(2)})${j.fallback ? `; ${j.fallback}` : ""}`;
  }

  private recordRelations(a: string, pairs: { c: Entry; j: Judgment }[], actions: Map<string, string>) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    for (const { c, j } of pairs)
      sql.exec(`INSERT INTO relations (a, b, relation, confidence, judge, fallback, ms, action, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a, c.id, j.relation, j.confidence, j.judge, j.fallback ?? null, j.ms, actions.get(c.id) ?? null, now);
  }

  // A duplicate write becomes corroboration: its origin and sources join the existing entry,
  // which keeps one body and gains independent support. The write is never silently dropped.
  private async corroborate(id: string, input: RememberInput, trust: TrustTier, j: Judgment): Promise<Entry> {
    const sql = this.ctx.storage.sql;
    const e = this.get(id)!;
    const o = input.origin;
    const now = Date.now();
    const sources = input.sources ?? [];
    const newTrust = TRUST_RANK[trust] > TRUST_RANK[e.trust] ? trust : e.trust;
    this.ctx.storage.transactionSync(() => {
      for (const s of sources) {
        const sid = `${s.uri}@${s.hash ?? "unhashed"}`;
        sql.exec(`INSERT OR IGNORE INTO sources VALUES (?, ?, ?, ?)`, sid, s.uri, s.hash ?? null, s.kind ?? "file");
        sql.exec(`INSERT OR IGNORE INTO entry_sources VALUES (?, ?)`, id, sid);
      }
      sql.exec(`INSERT INTO corroborations (entry, agent, session, supervisor, step, sources, judge, confidence, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, o.agent, o.session, o.supervisor, o.step ?? 0, JSON.stringify(sources), j.judge, j.confidence, now);
      const v = e.version + 1;
      sql.exec(`UPDATE entries SET version = ?, trust = ?, updated_at = ? WHERE id = ?`, v, newTrust, now, id);
      sql.exec(`INSERT INTO entry_versions VALUES (?, ?, ?, ?, ?, ?, ?)`, id, v, e.status, e.body, o.agent,
        `corroborated by ${o.agent} (${o.session}, step ${o.step ?? 0}): "${input.title}" (${j.judge}, ${j.confidence.toFixed(2)})`, now);
    });
    sql.exec(`UPDATE entries SET signature = ? WHERE id = ?`, await this.sign(this.get(id)!), id);
    await this.touchTtl();
    return this.get(id)!;
  }

  // Judge a pair or a batch without storing anything (used by the eval harness).
  async judgeOnly(newer: MemoryText, older: MemoryText[]) {
    return this.judge.judge(newer, older);
  }

  async relations() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM relations ORDER BY n`).toArray();
  }

  // ---------- attestation ----------

  private canonical(e: Entry) {
    return JSON.stringify({
      id: e.id, title: e.title, body: e.body, origin: e.origin, derivation: e.derivation,
      sources: e.sources.map((s) => ({ uri: s.uri, hash: s.hash ?? null })), parents: e.parents,
      ...(e.corroborations?.length ? { corroborations: e.corroborations.map((c) => ({ agent: c.agent, session: c.session, step: c.step, at: c.at })) } : {}),
    });
  }

  private async sign(e: Entry) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.env.TRUST_SIGNING_KEY || "trust-demo-signing-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(this.canonical(e)));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async verify(id: string) {
    this.init();
    const e = this.get(id);
    if (!e) return { id, valid: false, reason: "unknown entry" };
    const expected = await this.sign(e);
    return { id, valid: expected === e.signature, signature: e.signature };
  }

  // ---------- conflicts ----------
  // Opened by the judge on a write: both entries become contested and wait for review.
  private openConflict(a: string, b: string, reason: string) {
    const cid = `x-${this.next("conflict")}`;
    this.ctx.storage.sql.exec(`INSERT INTO conflicts VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?)`, cid, a, b, reason, Date.now());
    this.setStatus([a, b], "contested", "conflict-check", `conflict ${cid}: ${reason}`);
    return cid;
  }

  async resolveConflict(cid: string, decision: "keep_a" | "keep_b" | "keep_both" | "retract_both", reviewer: string, note = "") {
    this.init();
    const sql = this.ctx.storage.sql;
    const c = sql.exec(`SELECT * FROM conflicts WHERE id = ?`, cid).toArray()[0] as any;
    if (!c) throw new Error("Unknown conflict");
    if (c.status !== "open") throw new Error("Conflict already resolved");
    const keep = decision === "keep_a" ? [c.a] : decision === "keep_b" ? [c.b] : decision === "keep_both" ? [c.a, c.b] : [];
    const drop = [c.a, c.b].filter((x) => !keep.includes(x));
    const why = `conflict ${cid} resolved by ${reviewer}: ${decision}${note ? ` (${note})` : ""}`;
    this.setStatus(keep, "active", reviewer, why);
    this.setStatus(drop, "retracted", reviewer, why);
    sql.exec(`UPDATE conflicts SET status = 'resolved', resolution = ?, reviewer = ? WHERE id = ?`, decision, reviewer, cid);
    return { conflict: cid, decision, kept: keep, retracted: drop };
  }

  async conflicts() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM conflicts ORDER BY at`).toArray();
  }

  // ---------- staleness ----------
  // A cited source moved past the version the agent saw: flag what it taught, transitively.
  async sourceChanged(uri: string, newHash: string, actor: string) {
    this.init();
    const sql = this.ctx.storage.sql;
    const direct = sql
      .exec(`SELECT DISTINCT es.entry AS id FROM entry_sources es JOIN sources s ON s.id = es.source WHERE s.uri = ? AND IFNULL(s.hash, '') != ?`, uri, newHash)
      .toArray()
      .map((r: any) => r.id as string);
    const affected = this.descendants(direct).filter((id) => {
      const st = (sql.exec(`SELECT status FROM entries WHERE id = ?`, id).toArray()[0] as any)?.status;
      return st === "active" || st === "contested";
    });
    const changed = this.setStatus(affected, "stale", actor, `source changed: ${uri} is now ${newHash}`);
    return { source: uri, newHash, direct, flagged: changed, recalledBy: this.sessionsThatRecalled(changed) };
  }

  // Re-verify after a person or agent checks the memory against the new source version.
  async reverify(id: string, actor: string, sources: SourceRef[] = []) {
    this.init();
    const sql = this.ctx.storage.sql;
    for (const s of sources) {
      const sid = `${s.uri}@${s.hash ?? "unhashed"}`;
      sql.exec(`INSERT OR IGNORE INTO sources VALUES (?, ?, ?, ?)`, sid, s.uri, s.hash ?? null, s.kind ?? "file");
      sql.exec(`DELETE FROM entry_sources WHERE entry = ? AND source IN (SELECT id FROM sources WHERE uri = ?)`, id, s.uri);
      sql.exec(`INSERT OR IGNORE INTO entry_sources VALUES (?, ?)`, id, sid);
    }
    const changed = this.setStatus([id], "active", actor, "re-verified against current sources");
    const e = this.get(id)!;
    sql.exec(`UPDATE entries SET signature = ? WHERE id = ?`, await this.sign(e), id);
    return { id, reverified: changed.length > 0, entry: this.get(id) };
  }

  // ---------- export ----------
  // OKF-style bundle: one Markdown file per entry with YAML front matter, plus log.md.
  async exportBundle(scopeLabel: string) {
    this.init();
    const sql = this.ctx.storage.sql;
    const y = (v: unknown) => JSON.stringify(v ?? null);
    const files: { path: string; content: string }[] = [];
    for (const r of sql.exec(`SELECT id FROM entries ORDER BY created_at`).toArray() as any[]) {
      const e = this.get(r.id)!;
      const fm = [
        "---",
        `type: ${e.kind}`,
        `id: ${e.id}`,
        `title: ${y(e.title)}`,
        `status: ${e.status}`,
        `trust: ${e.trust}`,
        `provenance:`,
        `  derivation: ${e.derivation}`,
        `  agent: ${y(e.origin.agent)}`,
        `  session: ${e.origin.session}`,
        `  step: ${e.origin.step}`,
        `  supervisor: ${y(e.origin.supervisor)}`,
        `  sources:`,
        ...e.sources.map((s) => `    - { uri: ${y(s.uri)}, hash: ${y(s.hash)}, kind: ${s.kind} }`),
        `  parents: ${y(e.parents)}`,
        `lifecycle:`,
        `  version: ${e.version}`,
        `  created: ${new Date(e.created_at).toISOString()}`,
        `  updated: ${new Date(e.updated_at).toISOString()}`,
        `attestation:`,
        `  alg: HMAC-SHA256`,
        `  signature: ${e.signature}`,
        "---",
        "",
        e.body,
        "",
      ].join("\n");
      files.push({ path: `entries/${e.id}.md`, content: fm });
    }
    const log = (sql.exec(`SELECT * FROM entry_versions ORDER BY at, id, version`).toArray() as any[])
      .map((v) => `- ${new Date(v.at).toISOString()} ${v.id} v${v.version} ${v.status}: ${v.note} (${v.actor})`)
      .join("\n");
    files.push({ path: "log.md", content: `# ${scopeLabel} memory log\n\n${log}\n` });
    files.push({ path: "index.md", content: `---\ntype: index\ntitle: ${y(scopeLabel)}\n---\n\n${files.filter((f) => f.path.startsWith("entries/")).map((f) => `- [${f.path}](${f.path})`).join("\n")}\n` });
    return { format: "okf-style bundle (OKF v0.2 fields where they map)", files };
  }

  private setStatus(ids: string[], status: Status, actor: string, note: string) {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const changed: string[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const e = sql.exec(`SELECT version, status, body FROM entries WHERE id = ?`, id).toArray()[0] as any;
        if (!e || e.status === status) continue;
        const v = Number(e.version) + 1;
        sql.exec(`UPDATE entries SET status = ?, version = ?, updated_at = ? WHERE id = ?`, status, v, now, id);
        sql.exec(`INSERT INTO entry_versions VALUES (?, ?, ?, ?, ?, ?, ?)`, id, v, status, e.body, actor, note, now);
        changed.push(id);
      }
    });
    return changed;
  }

  async retract(id: string, actor: string, reason: string) {
    this.init();
    return this.setStatus([id], "retracted", actor, reason);
  }

  // Everything derived from these entries, transitively.
  private descendants(ids: string[]): string[] {
    const sql = this.ctx.storage.sql;
    const seen = new Set(ids);
    const queue = [...ids];
    while (queue.length) {
      const id = queue.shift()!;
      for (const r of sql.exec(`SELECT entry FROM entry_parents WHERE parent = ?`, id).toArray() as any[]) {
        if (!seen.has(r.entry)) {
          seen.add(r.entry);
          queue.push(r.entry);
        }
      }
    }
    return [...seen];
  }

  private sessionsThatRecalled(ids: string[]) {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return this.ctx.storage.sql
      .exec(`SELECT entry, session, MIN(step) AS step, MIN(at) AS first_at, COUNT(*) AS times FROM receipts WHERE entry IN (${marks}) GROUP BY entry, session`, ...ids)
      .toArray() as any[];
  }

  // Remove by source: quarantine everything that cites it, plus everything derived from that.
  async removeBySource(uri: string, actor: string) {
    this.init();
    const sql = this.ctx.storage.sql;
    const direct = sql
      .exec(`SELECT DISTINCT es.entry AS id FROM entry_sources es JOIN sources s ON s.id = es.source WHERE s.uri = ?`, uri)
      .toArray()
      .map((r: any) => r.id as string);
    const affected = this.descendants(direct);
    const changed = this.setStatus(affected, "quarantined", actor, `source removed: ${uri}`);
    return { source: uri, direct, affected, quarantined: changed, recalledBy: this.sessionsThatRecalled(affected) };
  }

  // Roll back a session: quarantine what it wrote, plus anything derived from it.
  async rollbackSession(session: string, actor: string) {
    this.init();
    const written = this.ctx.storage.sql.exec(`SELECT id FROM entries WHERE origin_session = ?`, session).toArray().map((r: any) => r.id as string);
    const affected = this.descendants(written);
    const changed = this.setStatus(affected, "quarantined", actor, `session rolled back: ${session}`);
    return { session, written, affected, quarantined: changed, recalledBy: this.sessionsThatRecalled(affected) };
  }

  // ---------- reads ----------

  get(id: string): Entry | null {
    this.init();
    const sql = this.ctx.storage.sql;
    const e = sql.exec(`SELECT * FROM entries WHERE id = ?`, id).toArray()[0] as any;
    if (!e) return null;
    const sources = sql
      .exec(`SELECT s.* FROM sources s JOIN entry_sources es ON es.source = s.id WHERE es.entry = ? ORDER BY es.rowid`, id)
      .toArray() as any[];
    const parents = sql.exec(`SELECT parent FROM entry_parents WHERE entry = ?`, id).toArray().map((r: any) => r.parent as string);
    return {
      id: e.id,
      kind: e.kind,
      title: e.title,
      body: e.body,
      status: e.status,
      trust: e.trust,
      derivation: e.derivation as Derivation,
      origin: { agent: e.origin_agent, session: e.origin_session, supervisor: e.origin_supervisor, step: e.origin_step },
      version: e.version,
      created_at: e.created_at,
      updated_at: e.updated_at,
      sources: sources.map((s) => ({ id: s.id, uri: s.uri, hash: s.hash ?? undefined, kind: s.kind })),
      parents,
      signature: e.signature ?? undefined,
      conflict: (() => {
        const c = sql.exec(`SELECT * FROM conflicts WHERE status = 'open' AND (a = ? OR b = ?)`, id, id).toArray()[0] as any;
        return c ? { id: c.id, with: c.a === id ? c.b : c.a, reason: c.reason } : null;
      })(),
      corroborations: (sql.exec(`SELECT * FROM corroborations WHERE entry = ? ORDER BY n`, id).toArray() as any[]).map(
        (c): Corroboration => ({ agent: c.agent, session: c.session, supervisor: c.supervisor, step: c.step, sources: JSON.parse(c.sources), judge: c.judge, confidence: c.confidence, at: c.at }),
      ),
      unsure: this.unsureFor(id),
      superseded_by: e.status === "superseded"
        ? ((sql.exec(`SELECT a FROM relations WHERE b = ? AND action = 'superseded' ORDER BY n DESC LIMIT 1`, id).toArray()[0] as any)?.a ?? null)
        : null,
    };
  }

  async getEntry(id: string) {
    return this.get(id);
  }

  async recall(query: string, session: string, step: number, limit = 5) {
    this.init();
    const sql = this.ctx.storage.sql;
    const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2);
    let ids: { id: string; score: number }[] = [];
    if (words.length && this.fts) {
      try {
        ids = sql
          .exec(`SELECT id, bm25(entries_fts) AS score FROM entries_fts WHERE entries_fts MATCH ? ORDER BY score LIMIT 50`, words.join(" OR "))
          .toArray()
          .map((r: any) => ({ id: r.id as string, score: -Number(r.score) }));
      } catch {
        ids = [];
      }
    }
    if (!ids.length && words.length) {
      const all = sql.exec(`SELECT id, title, body FROM entries`).toArray() as any[];
      ids = all
        .map((r) => ({ id: r.id as string, score: words.filter((w) => `${r.title} ${r.body}`.toLowerCase().includes(w)).length }))
        .filter((r) => r.score > 0);
    }
    const ranked = ids
      .map((r) => ({ e: this.get(r.id)!, score: r.score }))
      .filter((r) => r.e && r.e.status !== "quarantined" && r.e.status !== "retracted")
      .sort((a, b) =>
        TRUST_WEIGHT[b.e.trust] - (STATUS_PENALTY[b.e.status] ?? 0) - (TRUST_WEIGHT[a.e.trust] - (STATUS_PENALTY[a.e.status] ?? 0)) ||
        b.score - a.score || b.e.updated_at - a.e.updated_at)
      .slice(0, limit)
      .map((r) => r.e);
    const now = Date.now();
    ranked.forEach((e, i) => sql.exec(`INSERT INTO receipts (entry, version, session, step, rank, at) VALUES (?, ?, ?, ?, ?, ?)`, e.id, e.version, session, step, i + 1, now));
    return ranked;
  }

  // Backward: the full chain behind an entry, within this scope.
  async why(id: string) {
    this.init();
    const chain: Entry[] = [];
    const seen = new Set<string>();
    const walk = (eid: string) => {
      if (seen.has(eid)) return;
      seen.add(eid);
      const e = this.get(eid);
      if (!e) return;
      chain.push(e);
      e.parents.forEach(walk);
    };
    walk(id);
    return { entry: chain[0] ?? null, chain };
  }

  // Forward: entries derived from it, and every session that recalled any of them.
  async impact(id: string) {
    this.init();
    const affected = this.descendants([id]);
    return { entry: id, derived: affected.filter((x) => x !== id), recalledBy: this.sessionsThatRecalled(affected) };
  }

  async history(id: string) {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM entry_versions WHERE id = ? ORDER BY version`, id).toArray();
  }

  async graph() {
    this.init();
    const sql = this.ctx.storage.sql;
    return {
      entries: (sql.exec(`SELECT id FROM entries ORDER BY created_at`).toArray() as any[]).map((r) => this.get(r.id)),
      sources: sql.exec(`SELECT * FROM sources`).toArray(),
      entrySources: sql.exec(`SELECT * FROM entry_sources`).toArray(),
      parents: sql.exec(`SELECT * FROM entry_parents`).toArray(),
      receipts: sql.exec(`SELECT entry, session, MIN(step) AS step, MIN(at) AS first_at, COUNT(*) AS times FROM receipts GROUP BY entry, session`).toArray(),
      reviews: sql.exec(`SELECT * FROM reviews ORDER BY at`).toArray(),
      conflicts: sql.exec(`SELECT * FROM conflicts ORDER BY at`).toArray(),
      relations: sql.exec(`SELECT * FROM relations WHERE action IS NOT NULL ORDER BY n`).toArray(),
    };
  }

  // ---------- promotion reviews (used by the precedent scope) ----------

  async createReview(fromRef: string, title: string, original: string, proposed: string, removed: string[]) {
    this.init();
    const id = `r-${this.next("review")}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
      id, fromRef, title, original, proposed, JSON.stringify(removed), Date.now(),
    );
    await this.touchTtl();
    return this.ctx.storage.sql.exec(`SELECT * FROM reviews WHERE id = ?`, id).one();
  }

  async decideReview(id: string, approve: boolean, reviewer: string, prefix = "p") {
    this.init();
    const sql = this.ctx.storage.sql;
    const r = sql.exec(`SELECT * FROM reviews WHERE id = ?`, id).toArray()[0] as any;
    if (!r) throw new Error("Unknown review");
    if (r.status !== "pending") throw new Error(`Review already ${r.status}`);
    if (!approve) {
      sql.exec(`UPDATE reviews SET status = 'rejected', reviewer = ? WHERE id = ?`, reviewer, id);
      return { review: { ...r, status: "rejected", reviewer }, entry: null };
    }
    // The original is deliberately not stored in the precedent entry. Its provenance points to
    // "a matter" by an opaque reference, never to the client.
    const entry = await this.remember(prefix, {
      title: r.title,
      body: r.proposed,
      kind: "precedent",
      derivation: "promoted",
      sources: [{ uri: `matter:${r.from_ref}`, kind: "matter" }],
      origin: { agent: "review-gate", session: `review:${id}`, supervisor: reviewer, step: 0 },
    });
    sql.exec(`UPDATE reviews SET status = 'approved', reviewer = ?, entry = ?, original = '[withheld after approval]' WHERE id = ?`, reviewer, entry.id, id);
    return { review: { ...r, status: "approved", reviewer, entry: entry.id, original: "[withheld after approval]" }, entry };
  }

  async reviews() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM reviews ORDER BY at`).toArray();
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
