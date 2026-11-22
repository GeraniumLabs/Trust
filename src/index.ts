// Trust v1: agent memory that knows where every memory came from.
// Worker = API router + static demo page. Registry DO authorizes; Scope DOs store.

import { Registry, type ScopeDef } from "./registry";
import { Scope } from "./scope";
import type { SourceRef, Derivation } from "./types";

export { Registry, Scope };

interface Env {
  SCOPE: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Anyone can create a space; these limit how many. A day is 24 hours. "0" means no limit.
  TRUST_SPACES_PER_IP?: string; // per visitor IP a day, default 10 (loopback and service bindings aren't counted)
  TRUST_SPACES_PER_DAY?: string; // for the whole server a day, default 1000
}

const DEMO_SCOPES: ScopeDef[] = [
  { id: "northwind", label: "Northwind matter", client: "Northwind", kind: "matter", prefix: "n" },
  { id: "contoso", label: "Contoso matter", client: "Contoso", kind: "matter", prefix: "c" },
  { id: "precedent", label: "Firm precedent", client: "", kind: "precedent", prefix: "p" },
];
const SCOPE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SCOPE_KINDS = ["matter", "project", "precedent"];
function validScope(s: any): ScopeDef {
  if (!s || !SCOPE_ID.test(String(s.id))) throw new Error("scope id must be 1-40 lowercase letters, digits or dashes");
  if (!SCOPE_KINDS.includes(s.kind)) throw new Error(`scope kind must be one of ${SCOPE_KINDS.join(", ")}`);
  return { id: s.id, label: String(s.label || s.id).slice(0, 120), kind: s.kind, client: s.client ? String(s.client).slice(0, 120) : "", prefix: s.id };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

// Opaque, stable reference so promoted precedent can point to "a matter" without naming it.
async function opaqueRef(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// De-identify before anything crosses a wall: client names, then figures and money amounts.
function deidentify(text: string, clients: string[]) {
  const removed: string[] = [];
  let out = text;
  for (const c of clients.filter(Boolean)) {
    const re = new RegExp(`\\b${c}(['’]s)?\\b`, "gi");
    out = out.replace(re, (m) => {
      removed.push(m);
      return m.toLowerCase().endsWith("s") && /['’]s$/i.test(m) ? "the client's" : "the client";
    });
  }
  out = out.replace(/(\$|€|£)\s?\d[\d,.]*\s?(k|m|bn)?|\b\d+(\.\d+)?\s?%/gi, (m) => {
    removed.push(m);
    return "[figure]";
  });
  return { text: out, removed };
}

// Secrets never enter memory: a write that looks like it contains one is rejected outright.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["API key", /\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["credential assignment", /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-\/+=]{16,}/i],
];
function findSecret(...texts: string[]) {
  const t = texts.join("\n");
  return SECRET_PATTERNS.find(([, re]) => re.test(t))?.[0] ?? null;
}

// A change counts as influenced only if it was merged after the session first recalled the memory.
function influenced(recalledBy: any[], changes: any[]) {
  const first = new Map<string, number>();
  for (const r of recalledBy) first.set(r.session, Math.min(first.get(r.session) ?? Infinity, Number(r.first_at)));
  return changes.filter((c) => first.has(c.session) && Number(c.at) >= first.get(c.session)!);
}

const DAY = 24 * 3600 * 1000;
const limitOf = (v: string | undefined, d: number) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Math.max(0, Number(v)));

/** A 429 when this visitor, or the whole server, has created its share of spaces today; else null. */
async function creationLimit(req: Request, env: Env): Promise<Response | null> {
  const counter = (name: string) => env.REGISTRY.get(env.REGISTRY.idFromName(`__limit:${name}`)) as unknown as Registry;
  const tooMany = (what: string, retryAfter: number) =>
    new Response(JSON.stringify({ error: `${what} Try again in ${Math.ceil(retryAfter / 3600)} hour(s).` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(retryAfter) } });
  // Cloudflare sets CF-Connecting-IP on every request from the internet. Calls over a service
  // binding (another Worker on the same account) and local development have none or a loopback one.
  const ip = req.headers.get("cf-connecting-ip");
  if (ip && !/^(127\.|::1$|::ffff:127\.)/.test(ip)) {
    const tag = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`trust-ip:${ip}`)))).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
    const mine = await counter(`ip:${tag}`).hit(limitOf(env.TRUST_SPACES_PER_IP, 10), DAY);
    if (!mine.ok) return tooMany("You've created as many spaces as one visitor can today.", mine.retryAfter);
  }
  const all = await counter("all").hit(limitOf(env.TRUST_SPACES_PER_DAY, 1000), DAY);
  if (!all.ok) return tooMany("This server has created as many spaces as it allows today.", all.retryAfter);
  return null;
}

const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;

// Constant-time comparison of two secrets (via their hashes, so lengths don't leak either).

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/mcp/")) return mcp(req, env, url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const parts = url.pathname.split("/").filter(Boolean); // api, demo, :id, ...rest
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    try {
      // Creating a space is open to anyone, within the limits above.
      if ((parts[1] === "demo" || parts[1] === "spaces") && parts.length === 2 && req.method === "POST") {
        const limited = await creationLimit(req, env);
        if (limited) return limited;
      }
      // POST /api/demo -> a throwaway demo space (an hour, capped).
      if (parts[1] === "demo" && parts.length === 2 && req.method === "POST") {
        const id = crypto.randomUUID().slice(0, 8);
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName(id)) as unknown as Registry;
        const { adminToken } = await reg.setup(DEMO_SCOPES);
        return json({ demo: id, scopes: DEMO_SCOPES, adminToken });
      }
      // POST /api/spaces -> a persistent space with its own scopes. Its admin token is returned once.
      // { name?, scopes: [{ id, label?, kind: "project" | "matter" | "precedent", client? }] }
      if (parts[1] === "spaces" && parts.length === 2 && req.method === "POST") {
        const defs = (Array.isArray(body.scopes) ? body.scopes : []).map(validScope);
        if (!defs.length || defs.length > 50) return fail("a space needs 1 to 50 scopes", 400);
        if (new Set(defs.map((d: ScopeDef) => d.id)).size !== defs.length) return fail("scope ids must be unique", 400);
        if (defs.filter((d: ScopeDef) => d.kind === "precedent").length > 1) return fail("a space has at most one precedent scope", 400);
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName(id)) as unknown as Registry;
        const { adminToken } = await reg.setup(defs, { persistent: true, name: body.name ? String(body.name).slice(0, 120) : undefined });
        for (const d of defs) await (env.SCOPE.get(env.SCOPE.idFromName(`${id}:${d.id}`)) as unknown as Scope).setPersistent();
        return json({ space: id, persistent: true, scopes: defs, adminToken });
      }
      // Demo and persistent spaces share every other route: /api/demo/:id/... and /api/spaces/:id/...
      if ((parts[1] !== "demo" && parts[1] !== "spaces") || !parts[2]) return fail("Not found", 404);

      const demo = parts[2];
      const action = parts[3];
      // Casts: the generated RPC stub types exceed TS's depth limit for these return shapes.
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName(demo)) as unknown as Registry;
      if (!(await reg.exists())) return fail("This demo has expired. Start a new one.", 410);
      await reg.countOp();
      const scopeStub = (scope: string) => env.SCOPE.get(env.SCOPE.idFromName(`${demo}:${scope}`)) as unknown as Scope;

      // Identity comes from the bearer token only. Agents get a token when an admin starts their
      // session; the admin token comes back when the space is created. A session id in the body
      // is accepted only as a cross-check against the token.
      const caller = await reg.authenticate(bearer(req));
      const isAdmin = caller?.kind === "admin";
      const agent = caller?.kind === "agent" ? caller.session : null;
      const needAdmin = () => (isAdmin ? null : fail("This needs the admin token for this space.", caller ? 403 : 401));
      const needAgent = () => {
        if (!agent) return fail(isAdmin ? "This is an agent action: use the agent's session token." : "This needs an agent token (from POST sessions).", isAdmin ? 403 : 401);
        if (body.session && body.session !== agent.id) return fail(`This token is for session ${agent.id}, not ${body.session}.`, 403);
        return null;
      };
      // Reads of one scope: the admin may read any; an agent only what authorize() allows.
      const canRead = async (scope: string) => {
        if (isAdmin) return null;
        if (!agent) return fail("This needs a token.", 401);
        const a = await reg.authorize(agent.id, scope, "read");
        return a.ok ? null : fail(a.reason!, 403);
      };

      const spaceScopes = await reg.scopes();
      const scopeDef = (id: string) => spaceScopes.find((x) => x.id === id);
      const precedent = spaceScopes.find((x) => x.kind === "precedent")?.id ?? null;

      // GET /api/spaces/:id -> the space and its scopes; DELETE -> delete it and all its memory.
      if (!action) {
        { const denied = needAdmin(); if (denied) return denied; }
        if (req.method === "GET") return json({ space: demo, ...(await reg.info()) });
        if (req.method === "DELETE") {
          if (body.confirm !== demo && url.searchParams.get("confirm") !== demo) return fail(`Deleting a space can't be undone. Repeat its id as confirm=${demo}.`, 400);
          const ids = await reg.destroy();
          for (const sid of ids) await scopeStub(sid).destroy();
          return json({ deleted: demo, scopes: ids });
        }
        return fail("Not found", 404);
      }

      switch (action) {
        case "scopes": {
          { const denied = needAdmin(); if (denied) return denied; }
          if (req.method === "GET") return json(spaceScopes);
          const def = validScope(body);
          if (def.kind === "precedent" && precedent) return fail("this space already has a precedent scope", 400);
          await reg.addScope(def);
          if ((await reg.info()).persistent) await scopeStub(def.id).setPersistent();
          return json(def);
        }

        case "sessions": {
          // POST sessions/:id/end — the admin, or the agent ending its own session.
          if (parts[4] && parts[5] === "end") {
            if (!isAdmin && agent?.id !== parts[4]) return fail("Only the admin or the session itself can end it.", caller ? 403 : 401);
            return json(await reg.endSession(parts[4], isAdmin ? "admin" : agent!.agent));
          }
          const denied = needAdmin();
          if (denied) return denied;
          return json(await reg.startSession(body.scope, body.agent, body.supervisor));
        }

        case "remember": {
          const denied = needAgent();
          if (denied) return denied;
          const s = agent!;
          const scope = body.scope ?? s.scope;
          const check = await reg.authorize(s.id, scope, "write");
          if (!check.ok) return fail(check.reason!, 403);
          const secret = findSecret(body.title ?? "", body.body ?? "", JSON.stringify(body.sources ?? []));
          if (secret) {
            await reg.logEvent(s.agent, "remember", scope, "rejected", `looked like it contained a ${secret}`);
            return fail(`Rejected: this memory looks like it contains a ${secret}. Secrets are never stored.`, 422);
          }
          // Origin comes from the session, never from the agent's own claim.
          const entry = await scopeStub(scope).remember(scopeDef(scope)?.prefix ?? scope, {
            title: body.title,
            body: body.body,
            kind: body.kind,
            sources: (body.sources ?? []) as SourceRef[],
            parents: body.parents ?? [],
            derivation: (body.derivation ?? "observed") as Derivation,
            origin: { agent: s.agent, session: s.id, supervisor: s.supervisor, step: Number(body.step ?? 0) },
          });
          if (entry.deduped) await reg.logEvent(s.agent, "remember", scope, "merged", `duplicate of ${entry.id}; added as corroboration (${entry.deduped.judge})`);
          return json(entry);
        }

        // Judge without storing: { newer: {title, body, sources?}, older: [{...}] }. Used by eval/.
        case "judge": {
          { const denied = needAdmin(); if (denied) return denied; }
          if (!body.newer?.title || !Array.isArray(body.older) || !body.older.length) return fail("newer and a non-empty older[] are required", 400);
          if (body.older.length > 16) return fail("at most 16 older memories per call", 400);
          return json(await scopeStub("judge-scratch").judgeOnly(body.newer, body.older));
        }

        case "judge-config": {
          { const denied = needAdmin(); if (denied) return denied; }
          return json(await scopeStub("judge-scratch").judgeConfig());
        }

        case "relations": {
          { const denied = needAdmin(); if (denied) return denied; }
          return json(await scopeStub(parts[4]).relations());
        }

        case "recall": {
          const denied = needAgent();
          if (denied) return denied;
          const sid = agent!.id;
          const target = body.scope ?? agent!.scope;
          const auth = await reg.authorize(sid, target, "read");
          if (!auth.ok) return fail(auth.reason!, 403);
          const step = Number(body.step ?? 0);
          const own = await scopeStub(target).recall(body.query ?? "", sid, step, 5);
          let advisory: any[] = [];
          if (precedent && target !== precedent) {
            advisory = (await scopeStub(precedent).recall(body.query ?? "", sid, step, 3)).map((e) => ({ ...e, advisory: true }));
          }
          return json({ scope: target, results: [...own, ...advisory] });
        }

        case "why": {
          const [scope, id] = [parts[4], parts[5]];
          { const denied = await canRead(scope); if (denied) return denied; }
          return json(await scopeStub(scope).why(id));
        }

        case "impact": {
          const [scope, id] = [parts[4], parts[5]];
          { const denied = await canRead(scope); if (denied) return denied; }
          const impact = await scopeStub(scope).impact(id);
          const sessions = [...new Set(impact.recalledBy.map((r: any) => r.session as string))];
          return json({ ...impact, changes: influenced(impact.recalledBy, await reg.changesFor(sessions)) });
        }

        case "history": {
          const [scope, id] = [parts[4], parts[5]];
          { const denied = await canRead(scope); if (denied) return denied; }
          return json(await scopeStub(scope).history(id));
        }

        case "remove-source": {
          { const denied = needAdmin(); if (denied) return denied; }
          const out = await scopeStub(body.scope).removeBySource(body.uri, "admin");
          const sessions = [...new Set(out.recalledBy.map((r: any) => r.session as string))];
          await reg.logEvent("admin", "remove_source", body.scope, "ok", `${body.uri}: quarantined ${out.quarantined.join(", ") || "nothing"}`);
          return json({ ...out, changes: influenced(out.recalledBy, await reg.changesFor(sessions)) });
        }

        case "rollback": {
          { const denied = needAdmin(); if (denied) return denied; }
          const out = await scopeStub(body.scope).rollbackSession(body.session, "admin");
          await reg.logEvent("admin", "rollback_session", body.scope, "ok", `${body.session}: quarantined ${out.quarantined.join(", ") || "nothing"}`);
          return json(out);
        }

        case "changes": {
          { const denied = needAdmin(); if (denied) return denied; }
          return json(await reg.recordChange(body.session, body.ref, body.title));
        }

        case "promote": {
          { const denied = needAdmin(); if (denied) return denied; }
          const entry = await scopeStub(body.scope).getEntry(body.entry);
          if (!entry) return fail("Unknown entry", 404);
          if (!precedent) return fail("This space has no precedent scope to promote into.", 400);
          const clients = spaceScopes.map((s) => s.client ?? "").filter(Boolean);
          const t = deidentify(entry.title, clients);
          const b = deidentify(entry.body, clients);
          const ref = await opaqueRef(`${demo}:${body.scope}:${entry.id}`);
          const review = await scopeStub(precedent).createReview(ref, t.text, entry.body, b.text, [...t.removed, ...b.removed]);
          await reg.logEvent("admin", "promote_request", body.scope, "pending", `${entry.id} -> review ${review.id}`);
          return json(review);
        }

        case "reviews": {
          { const denied = needAdmin(); if (denied) return denied; }
          if (!precedent) return fail("This space has no precedent scope.", 400);
          if (req.method === "GET") return json(await scopeStub(precedent).reviews());
          const out = await scopeStub(precedent).decideReview(parts[4], !!body.approve, body.reviewer ?? "reviewer", scopeDef(precedent)?.prefix ?? precedent);
          await reg.logEvent(body.reviewer ?? "reviewer", "review", precedent, out.review.status, `${parts[4]}${out.entry ? ` -> ${out.entry.id}` : ""}`);
          return json(out);
        }

        case "walls": {
          { const denied = needAdmin(); if (denied) return denied; }
          return json(await reg.addWall(body.supervisor, body.scope, body.reason ?? "conflict"));
        }

        // The agent's decision on a pair: { session, scope, entry, other, relation, note }.
        case "relate": {
          const denied = needAgent();
          if (denied) return denied;
          const auth = await reg.authorize(agent!.id, body.scope ?? agent!.scope, "write");
          if (!auth.ok) return fail(auth.reason!, 403);
          body.scope ??= agent!.scope;
          try {
            const out = await scopeStub(body.scope).relate(body.entry, body.other, body.relation, auth.session.agent, body.note ?? "");
            await reg.logEvent(auth.session.agent, "relate", body.scope, body.entry, `${body.relation} ${body.other}: ${out.action}`);
            return json(out);
          } catch (err) {
            return fail((err as Error).message, 400);
          }
        }

        case "retract": {
          const denied = needAgent();
          if (denied) return denied;
          const auth = await reg.authorize(agent!.id, body.scope ?? agent!.scope, "write");
          if (!auth.ok) return fail(auth.reason!, 403);
          body.scope ??= agent!.scope;
          return json({ retracted: await scopeStub(body.scope).retract(body.entry, auth.session.agent, body.reason ?? "retracted") });
        }

        case "source-changed": {
          { const denied = needAdmin(); if (denied) return denied; }
          const out = await scopeStub(body.scope).sourceChanged(body.uri, body.hash, "source-watch");
          const sessions = [...new Set(out.recalledBy.map((r: any) => r.session as string))];
          await reg.logEvent("source-watch", "source_changed", body.scope, "ok", `${body.uri} -> ${body.hash}: flagged ${out.flagged.join(", ") || "nothing"}`);
          return json({ ...out, changes: influenced(out.recalledBy, await reg.changesFor(sessions)) });
        }

        case "reverify": {
          { const denied = needAdmin(); if (denied) return denied; }
          return json(await scopeStub(body.scope).reverify(body.entry, body.reviewer ?? "reviewer", body.sources ?? []));
        }

        case "conflicts": {
          { const denied = needAdmin(); if (denied) return denied; }
          if (req.method === "GET") return json(await scopeStub(parts[4]).conflicts());
          const out = await scopeStub(body.scope).resolveConflict(parts[4], body.decision, body.reviewer ?? "reviewer", body.note ?? "");
          await reg.logEvent(body.reviewer ?? "reviewer", "resolve_conflict", body.scope, "ok", `${parts[4]}: ${body.decision}`);
          return json(out);
        }

        case "verify": {
          { const denied = await canRead(parts[4]); if (denied) return denied; }
          return json(await scopeStub(parts[4]).verify(parts[5]));
        }

        case "export": {
          { const denied = needAdmin(); if (denied) return denied; }
          const sc = scopeDef(parts[4]);
          if (!sc) return fail("Unknown scope", 404);
          return json(await scopeStub(sc.id).exportBundle(sc.label));
        }

        case "graph": {
          { const denied = needAdmin(); if (denied) return denied; }
          const state = await reg.state();
          const scopes: Record<string, unknown> = {};
          for (const s of spaceScopes) scopes[s.id] = await scopeStub(s.id).graph();
          return json({ ...state, graphs: scopes });
        }

        default:
          return fail("Not found", 404);
      }
    } catch (e: any) {
      return fail(String(e?.message ?? e), 400);
    }
  },
};

(globalThis as any).__trustSelf = (req: Request, env: Env) => handler.fetch(req, env);
export default handler;

// ---------- MCP endpoint ----------
// Minimal MCP over streamable HTTP (JSON responses). Agents connect to /mcp/:demo and send their
// session token as `Authorization: Bearer ...`. The token is the agent's identity.

const MCP_TOOLS = [
  {
    name: "memory_recall",
    description: "Recall memories relevant to a query from this session's scope, plus advisory firm precedent. Every result carries its sources and origin.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, step: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_remember",
    description: "Store a learning with the sources it was drawn from. Origin is recorded automatically. Memories without sources are stored as unverified. If the result has `unsure` notes, the memory judge couldn't tell how this memory relates to an existing one; each note gives its reading (and a second model's, if configured). Check the evidence and record your decision with memory_relate.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        sources: { type: "array", items: { type: "object", properties: { uri: { type: "string" }, hash: { type: "string" }, kind: { type: "string" } }, required: ["uri"] } },
        parents: { type: "array", items: { type: "string" } },
        derivation: { type: "string", enum: ["observed", "inferred", "stated"] },
        step: { type: "number" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "memory_relate",
    description: "Record your decision on how two memories in this scope relate, usually after an `unsure` note. contradicts opens a review; supersedes retires the other memory if yours has at least its trust (otherwise opens a review); duplicate folds your memory into the other as corroboration; refines and unrelated are logged.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "The newer memory (usually yours)" },
        other: { type: "string", description: "The existing memory" },
        relation: { type: "string", enum: ["duplicate", "refines", "supersedes", "contradicts", "unrelated"] },
        note: { type: "string", description: "What you checked and why" },
      },
      required: ["entry", "other", "relation"],
    },
  },
  { name: "memory_retract", description: "Retract one of this scope's memories, with a reason. It stays in history.", inputSchema: { type: "object", properties: { entry: { type: "string" }, reason: { type: "string" } }, required: ["entry", "reason"] } },
  { name: "memory_why", description: "Explain a memory: its origin, sources and the memories it builds on.", inputSchema: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } },
  { name: "memory_impact", description: "What a memory affected: derived memories, sessions that recalled it, and changes merged after.", inputSchema: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } },
];

async function mcp(req: Request, env: Env, url: URL): Promise<Response> {
  const [, , demo, legacy] = url.pathname.split("/");
  if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const msg: any = await req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  // Every MCP request, the handshake included, needs an agent's session token.
  if (legacy) return error(-32001, "Session URLs are no longer accepted. Connect to /mcp/<space> and send the session token as Authorization: Bearer <token>.");
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName(demo)) as unknown as Registry;
  const token = bearer(req);
  const caller = await reg.authenticate(token).catch(() => null);
  if (caller?.kind !== "agent") return error(-32001, caller ? "MCP is for agents: use a session token, not the admin token." : "Missing, unknown, expired or revoked token.");

  if (msg.method === "initialize") {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "trust", version: "0.1.0" }, instructions: "Agent memory with provenance. Cite sources when you remember; check sources when you recall." });
  }
  if (msg.method === "ping") return reply({});
  if (msg.method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (msg.method !== "tools/call") return error(-32601, `Method not found: ${msg.method}`);

  // Tool calls go through the same HTTP API with the caller's token, so MCP gets exactly the
  // same authorization.

  const sess = caller.session;
  const session = sess.id;
  const a = msg.params?.arguments ?? {};
  const base = `${url.origin}/api/demo/${demo}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await (globalThis as any).__trustSelf(new Request(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: r.status, data: await r.json() };
  };
  let out: { status: number; data: any };
  switch (msg.params?.name) {
    case "memory_recall": out = await call("POST", "/recall", { session, query: a.query, step: a.step ?? 0 }); break;
    case "memory_remember": out = await call("POST", "/remember", { session, scope: sess.scope, ...a }); break;
    case "memory_relate": out = await call("POST", "/relate", { session, scope: sess.scope, entry: a.entry, other: a.other, relation: a.relation, note: a.note }); break;
    case "memory_retract": out = await call("POST", "/retract", { session, scope: sess.scope, entry: a.entry, reason: a.reason }); break;
    case "memory_why": out = await call("GET", `/why/${sess.scope}/${a.entry}`); break;
    case "memory_impact": out = await call("GET", `/impact/${sess.scope}/${a.entry}`); break;
    default: return error(-32602, `Unknown tool: ${msg.params?.name}`);
  }
  return reply({ content: [{ type: "text", text: JSON.stringify(out.data, null, 2) }], isError: out.status >= 400 });
}
