// Trust v1: agent memory that knows where every memory came from.
// Worker = API router + static demo page. Registry DO authorizes; Scope DOs store.

import { Registry } from "./registry";
import { Scope } from "./scope";
import type { SourceRef, Derivation } from "./types";

export { Registry, Scope };

interface Env {
  SCOPE: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const DEMO_SCOPES = [
  { id: "northwind", label: "Northwind matter", client: "Northwind", kind: "matter", prefix: "n" },
  { id: "contoso", label: "Contoso matter", client: "Contoso", kind: "matter", prefix: "c" },
  { id: "precedent", label: "Firm precedent", client: "", kind: "precedent", prefix: "p" },
];
const prefixOf = (scope: string) => DEMO_SCOPES.find((s) => s.id === scope)?.prefix ?? "e";

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

const handler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/mcp/")) return mcp(req, env, url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    const parts = url.pathname.split("/").filter(Boolean); // api, demo, :id, ...rest
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    try {
      // POST /api/demo -> new throwaway demo
      if (parts[1] === "demo" && parts.length === 2 && req.method === "POST") {
        const id = crypto.randomUUID().slice(0, 8);
        const reg = env.REGISTRY.get(env.REGISTRY.idFromName(id)) as unknown as Registry;
        await reg.setup(DEMO_SCOPES.map(({ prefix, ...s }) => s));
        return json({ demo: id, scopes: DEMO_SCOPES });
      }
      if (parts[1] !== "demo" || !parts[2]) return fail("Not found", 404);

      const demo = parts[2];
      const action = parts[3];
      // Casts: the generated RPC stub types exceed TS's depth limit for these return shapes.
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName(demo)) as unknown as Registry;
      if (!(await reg.exists())) return fail("This demo has expired. Start a new one.", 410);
      await reg.countOp();
      const scopeStub = (scope: string) => env.SCOPE.get(env.SCOPE.idFromName(`${demo}:${scope}`)) as unknown as Scope;

      switch (action) {
        case "sessions": {
          const s = await reg.startSession(body.scope, body.agent, body.supervisor);
          return json(s);
        }

        case "remember": {
          const auth = await reg.authorize(body.session, body.scope ?? "", "write");
          if (!auth.session) return fail(auth.reason ?? "unknown session", 403);
          const scope = body.scope ?? auth.session.scope;
          const check = scope === auth.session.scope ? auth : await reg.authorize(body.session, scope, "write");
          if (!check.ok) return fail(check.reason!, 403);
          const s = auth.session;
          const secret = findSecret(body.title ?? "", body.body ?? "", JSON.stringify(body.sources ?? []));
          if (secret) {
            await reg.logEvent(s.agent, "remember", scope, "rejected", `looked like it contained a ${secret}`);
            return fail(`Rejected: this memory looks like it contains a ${secret}. Secrets are never stored.`, 422);
          }
          // Origin comes from the session, never from the agent's own claim.
          const entry = await scopeStub(scope).remember(prefixOf(scope), {
            title: body.title,
            body: body.body,
            kind: body.kind,
            sources: (body.sources ?? []) as SourceRef[],
            parents: body.parents ?? [],
            derivation: (body.derivation ?? "observed") as Derivation,
            origin: { agent: s.agent, session: s.id, supervisor: s.supervisor, step: Number(body.step ?? 0) },
          });
          return json(entry);
        }

        case "recall": {
          const first = await reg.authorize(body.session, body.scope ?? "precedent", "read");
          if (!first.session) return fail(first.reason ?? "unknown session", 403);
          const target = body.scope ?? first.session.scope;
          const auth = await reg.authorize(body.session, target, "read");
          if (!auth.ok) return fail(auth.reason!, 403);
          const step = Number(body.step ?? 0);
          const own = await scopeStub(target).recall(body.query ?? "", body.session, step, 5);
          let advisory: any[] = [];
          if (target !== "precedent") {
            advisory = (await scopeStub("precedent").recall(body.query ?? "", body.session, step, 3)).map((e) => ({ ...e, advisory: true }));
          }
          return json({ scope: target, results: [...own, ...advisory] });
        }

        case "why": {
          const [scope, id] = [parts[4], parts[5]];
          return json(await scopeStub(scope).why(id));
        }

        case "impact": {
          const [scope, id] = [parts[4], parts[5]];
          const impact = await scopeStub(scope).impact(id);
          const sessions = [...new Set(impact.recalledBy.map((r: any) => r.session as string))];
          return json({ ...impact, changes: influenced(impact.recalledBy, await reg.changesFor(sessions)) });
        }

        case "history": {
          const [scope, id] = [parts[4], parts[5]];
          return json(await scopeStub(scope).history(id));
        }

        case "remove-source": {
          const out = await scopeStub(body.scope).removeBySource(body.uri, "admin");
          const sessions = [...new Set(out.recalledBy.map((r: any) => r.session as string))];
          await reg.logEvent("admin", "remove_source", body.scope, "ok", `${body.uri}: quarantined ${out.quarantined.join(", ") || "nothing"}`);
          return json({ ...out, changes: influenced(out.recalledBy, await reg.changesFor(sessions)) });
        }

        case "rollback": {
          const out = await scopeStub(body.scope).rollbackSession(body.session, "admin");
          await reg.logEvent("admin", "rollback_session", body.scope, "ok", `${body.session}: quarantined ${out.quarantined.join(", ") || "nothing"}`);
          return json(out);
        }

        case "changes": {
          const auth = await reg.authorize(body.session, body.scope ?? "", "write");
          if (!auth.session) return fail("unknown session", 403);
          return json(await reg.recordChange(body.session, body.ref, body.title));
        }

        case "promote": {
          const entry = await scopeStub(body.scope).getEntry(body.entry);
          if (!entry) return fail("Unknown entry", 404);
          const clients = DEMO_SCOPES.map((s) => s.client);
          const t = deidentify(entry.title, clients);
          const b = deidentify(entry.body, clients);
          const ref = await opaqueRef(`${demo}:${body.scope}:${entry.id}`);
          const review = await scopeStub("precedent").createReview(ref, t.text, entry.body, b.text, [...t.removed, ...b.removed]);
          await reg.logEvent("admin", "promote_request", body.scope, "pending", `${entry.id} -> review ${review.id}`);
          return json(review);
        }

        case "reviews": {
          if (req.method === "GET") return json(await scopeStub("precedent").reviews());
          const out = await scopeStub("precedent").decideReview(parts[4], !!body.approve, body.reviewer ?? "reviewer");
          await reg.logEvent(body.reviewer ?? "reviewer", "review", "precedent", out.review.status, `${parts[4]}${out.entry ? ` -> ${out.entry.id}` : ""}`);
          return json(out);
        }

        case "walls": {
          return json(await reg.addWall(body.supervisor, body.scope, body.reason ?? "conflict"));
        }

        case "retract": {
          const auth = await reg.authorize(body.session, body.scope, "write");
          if (!auth.ok) return fail(auth.reason!, 403);
          return json({ retracted: await scopeStub(body.scope).retract(body.entry, auth.session.agent, body.reason ?? "retracted") });
        }

        case "source-changed": {
          const out = await scopeStub(body.scope).sourceChanged(body.uri, body.hash, "source-watch");
          const sessions = [...new Set(out.recalledBy.map((r: any) => r.session as string))];
          await reg.logEvent("source-watch", "source_changed", body.scope, "ok", `${body.uri} -> ${body.hash}: flagged ${out.flagged.join(", ") || "nothing"}`);
          return json({ ...out, changes: influenced(out.recalledBy, await reg.changesFor(sessions)) });
        }

        case "reverify": {
          return json(await scopeStub(body.scope).reverify(body.entry, body.reviewer ?? "reviewer", body.sources ?? []));
        }

        case "conflicts": {
          if (req.method === "GET") return json(await scopeStub(parts[4]).conflicts());
          const out = await scopeStub(body.scope).resolveConflict(parts[4], body.decision, body.reviewer ?? "reviewer", body.note ?? "");
          await reg.logEvent(body.reviewer ?? "reviewer", "resolve_conflict", body.scope, "ok", `${parts[4]}: ${body.decision}`);
          return json(out);
        }

        case "verify": {
          return json(await scopeStub(parts[4]).verify(parts[5]));
        }

        case "export": {
          const sc = DEMO_SCOPES.find((x) => x.id === parts[4]);
          if (!sc) return fail("Unknown scope", 404);
          return json(await scopeStub(sc.id).exportBundle(sc.label));
        }

        case "graph": {
          const state = await reg.state();
          const scopes: Record<string, unknown> = {};
          for (const s of DEMO_SCOPES) scopes[s.id] = await scopeStub(s.id).graph();
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
// Minimal MCP over streamable HTTP (JSON responses). Agents connect to /mcp/:demo/:session.
// In this demo the session in the URL is the agent's identity; production would use a bearer token.

const MCP_TOOLS = [
  {
    name: "memory_recall",
    description: "Recall memories relevant to a query from this session's scope, plus advisory firm precedent. Every result carries its sources and origin.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, step: { type: "number" } }, required: ["query"] },
  },
  {
    name: "memory_remember",
    description: "Store a learning with the sources it was drawn from. Origin is recorded automatically. Memories without sources are stored as unverified.",
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
  { name: "memory_retract", description: "Retract one of this scope's memories, with a reason. It stays in history.", inputSchema: { type: "object", properties: { entry: { type: "string" }, reason: { type: "string" } }, required: ["entry", "reason"] } },
  { name: "memory_why", description: "Explain a memory: its origin, sources and the memories it builds on.", inputSchema: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } },
  { name: "memory_impact", description: "What a memory affected: derived memories, sessions that recalled it, and changes merged after.", inputSchema: { type: "object", properties: { entry: { type: "string" } }, required: ["entry"] } },
];

async function mcp(req: Request, env: Env, url: URL): Promise<Response> {
  const [, , demo, session] = url.pathname.split("/");
  if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const msg: any = await req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  if (msg.method === "initialize") {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "trust", version: "0.1.0" }, instructions: "Agent memory with provenance. Cite sources when you remember; check sources when you recall." });
  }
  if (msg.method === "ping") return reply({});
  if (msg.method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (msg.method !== "tools/call") return error(-32601, `Method not found: ${msg.method}`);

  // Route tool calls through the same HTTP API, so MCP gets exactly the same authorization.
  const reg = env.REGISTRY.get(env.REGISTRY.idFromName(demo)) as unknown as Registry;
  const state = await reg.state().catch(() => null);
  const sess = (state?.sessions as any[] | undefined)?.find((x) => x.id === session);
  if (!sess) return error(-32001, "Unknown demo or session");
  const a = msg.params?.arguments ?? {};
  const base = `${url.origin}/api/demo/${demo}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await (globalThis as any).__trustSelf(new Request(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: r.status, data: await r.json() };
  };
  let out: { status: number; data: any };
  switch (msg.params?.name) {
    case "memory_recall": out = await call("POST", "/recall", { session, query: a.query, step: a.step ?? 0 }); break;
    case "memory_remember": out = await call("POST", "/remember", { session, scope: sess.scope, ...a }); break;
    case "memory_retract": out = await call("POST", "/retract", { session, scope: sess.scope, entry: a.entry, reason: a.reason }); break;
    case "memory_why": out = await call("GET", `/why/${sess.scope}/${a.entry}`); break;
    case "memory_impact": out = await call("GET", `/impact/${sess.scope}/${a.entry}`); break;
    default: return error(-32602, `Unknown tool: ${msg.params?.name}`);
  }
  return reply({ content: [{ type: "text", text: JSON.stringify(out.data, null, 2) }], isError: out.status >= 400 });
}
