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
const AGENT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Tokens are random 256-bit values. Only their SHA-256 hash is stored, so a copy of the database
// can't be replayed as credentials. The prefix says what kind of token it is, for humans and
// secret scanners; it grants nothing.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function hashToken(token: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken(kind: "adm" | "agt") {
  return `trust_${kind}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export interface ScopeDef {
  id: string;
  label: string;
  kind: "matter" | "project" | "precedent";
  client?: string; // names stripped when promoting to precedent
  prefix?: string; // entry ids are <prefix>-<n>; defaults to the scope id
}

export type Caller = { kind: "admin" } | { kind: "agent"; session: SessionInfo };

export class Registry extends DurableObject<RegistryEnv> {
  private ready = false;

  private init() {
    if (this.ready) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, label TEXT, client TEXT, kind TEXT, prefix TEXT)`);
    try {
      sql.exec(`ALTER TABLE scopes ADD COLUMN prefix TEXT`); // spaces created before prefixes were stored
    } catch {}
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, scope TEXT, agent TEXT, supervisor TEXT, status TEXT, started_at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS walls (supervisor TEXT, scope TEXT, reason TEXT, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, session TEXT, ref TEXT, title TEXT, at INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT, session TEXT, created_at INTEGER, expires_at INTEGER, revoked_at INTEGER)`);
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

  // A demo space deletes itself after an hour and has an operation cap. A persistent space keeps
  // its memory until an admin deletes it.
  async setup(scopes: ScopeDef[], opts: { persistent?: boolean; name?: string } = {}) {
    this.init();
    const sql = this.ctx.storage.sql;
    if ((await this.exists())) throw new Error("this space already exists");
    for (const s of scopes) this.insertScope(s);
    sql.exec(`INSERT OR REPLACE INTO meta VALUES ('created_at', ?)`, String(Date.now()));
    sql.exec(`INSERT OR REPLACE INTO meta VALUES ('persistent', ?)`, opts.persistent ? "1" : "0");
    if (opts.name) sql.exec(`INSERT OR REPLACE INTO meta VALUES ('name', ?)`, opts.name);
    if (!opts.persistent) await this.ctx.storage.setAlarm(Date.now() + DEMO_TTL_MS);
    // The admin token belongs to whoever created this space: a person, or the service acting for them.
    const adminToken = newToken("adm");
    sql.exec(`INSERT INTO tokens VALUES (?, 'admin', NULL, ?, NULL, NULL)`, await hashToken(adminToken), Date.now());
    this.log("admin", "setup", "", "ok", "space created; admin token issued");
    return { scopes: await this.scopes(), adminToken };
  }

  // Who is calling. Returns null for a missing, unknown, expired or revoked token.
  async authenticate(token: string | null): Promise<Caller | null> {
    this.init();
    if (!token) return null;
    const sql = this.ctx.storage.sql;
    const row = sql.exec(`SELECT * FROM tokens WHERE hash = ?`, await hashToken(token)).toArray()[0] as any;
    if (!row || row.revoked_at || (row.expires_at && Number(row.expires_at) < Date.now())) {
      this.log("unknown", "authenticate", "", "denied", row ? (row.revoked_at ? "revoked token" : "expired token") : "unknown token");
      return null;
    }
    if (row.kind === "admin") return { kind: "admin" };
    const session = sql.exec(`SELECT * FROM sessions WHERE id = ?`, row.session).toArray()[0] as unknown as SessionInfo | undefined;
    return session ? { kind: "agent", session } : null;
  }

  // Ends a session and revokes its token. Its memories stay; it can't act again.
  async endSession(sessionId: string, actor: string) {
    this.init();
    const sql = this.ctx.storage.sql;
    const s = sql.exec(`SELECT * FROM sessions WHERE id = ?`, sessionId).toArray()[0] as any;
    if (!s) throw new Error("unknown session");
    sql.exec(`UPDATE sessions SET status = 'ended' WHERE id = ?`, sessionId);
    sql.exec(`UPDATE tokens SET revoked_at = ? WHERE session = ? AND revoked_at IS NULL`, Date.now(), sessionId);
    this.log(actor, "end_session", s.scope, "ok", `${sessionId} ended; token revoked`);
    return { id: sessionId, status: "ended" };
  }

  private insertScope(s: ScopeDef) {
    this.ctx.storage.sql.exec(`INSERT INTO scopes (id, label, client, kind, prefix) VALUES (?, ?, ?, ?, ?)`, s.id, s.label, s.client ?? "", s.kind, s.prefix ?? s.id);
  }

  async scopes(): Promise<ScopeDef[]> {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT * FROM scopes`).toArray() as any[];
  }

  async addScope(s: ScopeDef) {
    this.init();
    if (this.ctx.storage.sql.exec(`SELECT 1 FROM scopes WHERE id = ?`, s.id).toArray().length) throw new Error(`scope ${s.id} already exists`);
    this.insertScope(s);
    this.log("admin", "add_scope", s.id, "ok", `${s.kind}: ${s.label}`);
    return s;
  }

  async info() {
    this.init();
    const meta = (k: string) => (this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0] as any)?.v ?? null;
    return { name: meta("name"), persistent: meta("persistent") === "1", created_at: Number(meta("created_at")), scopes: await this.scopes() };
  }

  // Deletes the space's registry (sessions, tokens, walls, audit). Returns its scope ids so the
  // caller can delete each scope's store too.
  async destroy() {
    this.init();
    const ids = (await this.scopes()).map((s) => s.id);
    await this.ctx.storage.deleteAll();
    this.ready = false;
    return ids;
  }

  async exists() {
    this.init();
    return this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM scopes`).one().n as number > 0;
  }

  async countOp() {
    this.init();
    const n = this.next("ops");
    const persistent = (this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = 'persistent'`).toArray()[0] as any)?.v === "1";
    if (!persistent && n > OP_LIMIT) throw new Error("This demo has reached its operation limit. Start a new demo.");
    return n;
  }

  // Only the admin can start a session: the agent's name, supervisor and scope are fixed here,
  // and every memory it writes carries them. The token is returned once and never stored.
  async startSession(scope: string, agent: string, supervisor: string): Promise<SessionInfo & { token: string; token_expires_at: number }> {
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
    if (!agent?.trim() || !supervisor?.trim()) throw new Error("agent and supervisor are required");
    sql.exec(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)`, s.id, s.scope, s.agent, s.supervisor, s.status, s.started_at);
    const token = newToken("agt");
    const expires = Date.now() + AGENT_TOKEN_TTL_MS;
    sql.exec(`INSERT INTO tokens VALUES (?, 'agent', ?, ?, ?, NULL)`, await hashToken(token), id, Date.now(), expires);
    this.log(agent, "start_session", scope, "ok", `${id} supervised by ${supervisor}`);
    return { ...s, token, token_expires_at: expires };
  }

  // The one place access is decided. Checked on every call, so a new wall applies immediately.
  async authorize(sessionId: string, scope: string, action: "read" | "write") {
    this.init();
    const sql = this.ctx.storage.sql;
    const s = sql.exec(`SELECT * FROM sessions WHERE id = ?`, sessionId).toArray()[0] as unknown as SessionInfo | undefined;
    if (!s) return { ok: false, reason: "unknown session" } as const;
    if (s.status !== "active") {
      const why = s.status === "ended" ? "session has ended" : "session paused by a wall";
      this.log(s.agent, action, scope, "denied", `${s.id}: ${why}`);
      return { ok: false, reason: why, session: s } as const;
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
