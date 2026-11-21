// Scope: one Durable Object per scope (a matter, a project, or the firm precedent library).
// Its SQLite database is the source of truth: current entries, an append-only version
// history, sources with content hashes, derivation links, and recall receipts.

import { DurableObject } from "cloudflare:workers";
import type { Derivation, Entry, RememberInput, SourceRef, Status, TrustTier } from "./types";

const TTL_MS = 60 * 60 * 1000;
const TRUST_WEIGHT: Record<TrustTier, number> = { reviewed: 3, sourced: 2, unverified: 1 };
// Flagged entries are still recalled, but ranked below clean ones and labeled.
const STATUS_PENALTY: Record<string, number> = { active: 0, contested: 1.5, stale: 1.5 };

const NEGATION = /\b(not|never|don['’]?t|do not|avoid|no longer|stop|shouldn['’]?t|must not)\b/i;
const STOP = new Set("the and for with from that this into when then than are was were has have use using via its".split(" "));
const words = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9_.()]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
};

interface ScopeEnv {
  TRUST_SIGNING_KEY?: string;
}

export class Scope extends DurableObject<ScopeEnv> {
  private ready = false;
  private fts = false;

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

  private async touchTtl() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
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
    const id = `${prefix}-${this.next("entry")}`;
    const now = Date.now();
    const o = input.origin;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO entries VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        id, input.kind ?? "learning", input.title, input.body, trust, input.derivation ?? "observed",
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
    this.detectConflict(id);
    await this.touchTtl();
    return this.get(id)!;
  }

  // ---------- attestation ----------

  private canonical(e: Entry) {
    return JSON.stringify({
      id: e.id, title: e.title, body: e.body, origin: e.origin, derivation: e.derivation,
      sources: e.sources.map((s) => ({ uri: s.uri, hash: s.hash ?? null })), parents: e.parents,
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
  // Two active entries from different sessions that overlap heavily (shared sources or wording)
  // but disagree (one negates the other) are both marked contested and sent for review.
  // A model-based check can replace the heuristic later; the review flow stays the same.
  private detectConflict(id: string) {
    const sql = this.ctx.storage.sql;
    const e = this.get(id)!;
    const ew = words(`${e.title} ${e.body}`);
    const eSources = new Set(e.sources.map((s) => s.uri));
    const others = (sql.exec(`SELECT id FROM entries WHERE id != ? AND status IN ('active', 'stale') AND origin_session != ? AND kind = ?`, id, e.origin.session, e.kind).toArray() as any[])
      .map((r) => this.get(r.id)!)
      .filter((o) => !e.parents.includes(o.id) && !o.parents.includes(e.id));
    // Score every candidate and take the strongest disagreement, not the first one found.
    let best: { o: Entry; overlap: number; shared: boolean } | null = null;
    for (const o of others) {
      const overlap = jaccard(ew, words(`${o.title} ${o.body}`));
      const shared = o.sources.some((s) => eSources.has(s.uri));
      const disagree = NEGATION.test(`${e.title} ${e.body}`) !== NEGATION.test(`${o.title} ${o.body}`);
      const score = overlap + (shared ? 0.1 : 0);
      if (disagree && (overlap >= 0.25 || (shared && overlap >= 0.15)) && (!best || score > best.overlap + (best.shared ? 0.1 : 0))) best = { o, overlap, shared };
    }
    if (best) {
      const cid = `x-${this.next("conflict")}`;
      const reason = `${Math.round(best.overlap * 100)}% wording overlap${best.shared ? ", shared source" : ""}, opposite instructions`;
      sql.exec(`INSERT INTO conflicts VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?)`, cid, best.o.id, e.id, reason, Date.now());
      this.setStatus([best.o.id, e.id], "contested", "conflict-check", `conflict ${cid}: ${reason}`);
      return cid;
    }
    return null;
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

  async decideReview(id: string, approve: boolean, reviewer: string) {
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
    const entry = await this.remember("p", {
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
