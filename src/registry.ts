// Registry: one Durable Object per demo. Owns scopes, sessions, walls, merged changes
// and the audit trail. Every read and write is authorized here before a scope is touched.

import { DurableObject } from "cloudflare:workers";
import type { SessionInfo } from "./types";

export interface RegistryEnv {
  SCOPE: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

const DEMO_TTL_MS = 60 * 60 * 1000; // throwaway demos expire after an hour
const OP_LIMIT = 3000; // per-demo cap so a public demo can't be abused

export class Registry extends DurableObject<RegistryEnv> {
  private ready = false;

  private init() {
    if (this.ready) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, label TEXT, client TEXT, kind TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, scope TEXT, agent TEXT, supervisor TEXT, status TEXT, started_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS walls (supervisor TEXT, scope TEXT, reason TEXT, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, session TEXT, ref TEXT, title TEXT, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT, action TEXT, scope TEXT, outcome TEXT, detail TEXT)`);
    this.ready = true;
  }

  private next(key: string): number {
    const sql = this.ctx.storage.sql;
    const row = sql.exec(`SELECT v FROM meta WHERE k = ?`, key).toArray()[0];
    const n = row ? Number(row.v) + 1 : 1;
    sql.exec(`INSERT OR REPLACE INTO meta VALUES (?, ?)`, key, String(n));
    return n;
  }

  async setup(scopes: { id: string; label: string; client: string; kind: string }[]) {
    this.init();
    const sql = this.ctx.storage.sql;
    for (const s of scopes) sql.exec(`INSERT OR REPLACE INTO scopes VALUES (?, ?, ?, ?)`, s.id, s.label, s.client, s.kind);
    sql.exec(`INSERT OR REPLACE INTO meta VALUES ('created_at', ?)`, String(Date.now()));
    await this.ctx.storage.setAlarm(Date.now() + DEMO_TTL_MS);
    return this.scopes();
  }

  async scopes() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM scopes`).toArray() as any[];
  }

  async exists() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM scopes`).one().n as number > 0;
  }

  async countOp() {
    this.init();
    const n = this.next("ops");
    if (n > OP_LIMIT) throw new Error("This demo has reached its operation limit. Start a new demo.");
    return n;
  }

  async startSession(scope: string, agent: string, supervisor: string): Promise<SessionInfo> {
    this.init();
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM scopes WHERE id = ?`, scope).toArray().length) throw new Error(`Unknown scope ${scope}`);
    const walled = sql.exec(`SELECT reason FROM walls WHERE supervisor = ? AND scope = ?`, supervisor, scope).toArray()[0];
    if (walled) {
      this.log(agent, "start_session", scope, "denied", `${supervisor} is walled off: ${walled.reason}`);
      throw new Error(`${supervisor} is walled off from ${scope}`);
    }
    const id = `s-${this.next("session")}`;
    const s: SessionInfo = { id, scope, agent, supervisor, status: "active", started_at: Date.now() };
    sql.exec(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)`, s.id, s.scope, s.agent, s.supervisor, s.status, s.started_at);
    this.log(agent, "start_session", scope, "ok", `${id} supervised by ${supervisor}`);
    return s;
  }

  // The one place access is decided. Checked on every call, so a new wall applies immediately.
  async authorize(sessionId: string, scope: string, action: "read" | "write") {
    this.init();
    const sql = this.ctx.storage.sql;
    const s = sql.exec(`SELECT * FROM sessions WHERE id = ?`, sessionId).toArray()[0] as unknown as SessionInfo | undefined;
    if (!s) return { ok: false, reason: "unknown session" } as const;
    if (s.status !== "active") {
      this.log(s.agent, action, scope, "denied", `${s.id} is paused by a wall`);
      return { ok: false, reason: "session paused by a wall", session: s } as const;
    }
    const target = sql.exec(`SELECT * FROM scopes WHERE id = ?`, scope).toArray()[0] as any;
    if (!target) return { ok: false, reason: "unknown scope", session: s } as const;
    const own = scope === s.scope;
    const precedentRead = target.kind === "precedent" && action === "read";
    if (!own && !precedentRead) {
      // Log against the caller's own scope, without revealing anything about the target's contents.
      this.log(s.agent, action, s.scope, "denied", `${s.id} (bound to ${s.scope}) tried to ${action} another matter`);
      return { ok: false, reason: `session is bound to ${s.scope}`, session: s } as const;
    }
    return { ok: true, session: s, advisory: precedentRead } as const;
  }

  async addWall(supervisor: string, scope: string, reason: string) {
    this.init();
    const sql = this.ctx.storage.sql;
    sql.exec(`INSERT INTO walls VALUES (?, ?, ?, ?)`, supervisor, scope, reason, Date.now());
    const paused = sql.exec(`SELECT id FROM sessions WHERE supervisor = ? AND scope = ? AND status = 'active'`, supervisor, scope).toArray().map((r: any) => r.id as string);
    sql.exec(`UPDATE sessions SET status = 'paused' WHERE supervisor = ? AND scope = ?`, supervisor, scope);
    this.log("admin", "add_wall", scope, "ok", `${supervisor}: ${reason}; paused ${paused.join(", ") || "no sessions"}`);
    return { paused };
  }

  async recordChange(sessionId: string, ref: string, title: string) {
    this.init();
    const id = `ch-${this.next("change")}`;
    this.ctx.storage.sql.exec(`INSERT INTO changes VALUES (?, ?, ?, ?, ?)`, id, sessionId, ref, title, Date.now());
    return { id, session: sessionId, ref, title };
  }

  async changesFor(sessionIds: string[]) {
    this.init();
    if (!sessionIds.length) return [];
    const marks = sessionIds.map(() => "?").join(",");
    return this.ctx.storage.sql.exec(`SELECT * FROM changes WHERE session IN (${marks})`, ...sessionIds).toArray() as any[];
  }

  async state() {
    this.init();
    const sql = this.ctx.storage.sql;
    return {
      scopes: sql.exec(`SELECT * FROM scopes`).toArray(),
      sessions: sql.exec(`SELECT * FROM sessions ORDER BY started_at`).toArray(),
      walls: sql.exec(`SELECT * FROM walls`).toArray(),
      changes: sql.exec(`SELECT * FROM changes ORDER BY at`).toArray(),
      audit: sql.exec(`SELECT * FROM audit ORDER BY n DESC LIMIT 50`).toArray(),
    };
  }

  async logEvent(actor: string, action: string, scope: string, outcome: string, detail: string) {
    this.init();
    this.log(actor, action, scope, outcome, detail);
  }

  private log(actor: string, action: string, scope: string, outcome: string, detail: string) {
    this.ctx.storage.sql.exec(`INSERT INTO audit (at, actor, action, scope, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)`, Date.now(), actor, action, scope, outcome, detail);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
