#!/usr/bin/env node
// End-to-end checks for Trust v1 against a running Worker (wrangler dev or deployed).
// Usage: BASE_URL=http://localhost:8787 node test/e2e.mjs

import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
let demo;

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const post = (p, b) => api("POST", `/demo/${demo}${p}`, b);
const get = (p) => api("GET", `/demo/${demo}${p}`);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

const created = await api("POST", "/demo");
demo = created.data.demo;
assert.ok(demo, "demo created");

const s1 = (await post("/sessions", { scope: "northwind", agent: "claude-code", supervisor: "Avery" })).data;
const s2 = (await post("/sessions", { scope: "contoso", agent: "codex", supervisor: "Blake" })).data;
const remember = (s, scope, b) => post("/remember", { session: s.id, scope, ...b });

let e1, e2, e3, c1;

await test("origin comes from the session, sources are hashed", async () => {
  e1 = (await remember(s1, "northwind", {
    title: "Rounding diverges in billing",
    body: "Northwind invoice totals round in three places and drift by one cent.",
    sources: [{ uri: "northwind/billing/round.ts", hash: "a41c9e", kind: "file" }, { uri: "ci://run/2291", kind: "log" }],
    step: 4,
  })).data;
  assert.equal(e1.origin.session, s1.id);
  assert.equal(e1.origin.supervisor, "Avery");
  assert.equal(e1.trust, "sourced");
  assert.equal(e1.sources[0].hash, "a41c9e");
});

await test("an entry with no sources is stored as unverified", async () => {
  const u = (await remember(s1, "northwind", { title: "Hunch", body: "The billing cron might be slow.", step: 5 })).data;
  assert.equal(u.trust, "unverified");
});

await test("derived entries link to their parents", async () => {
  e2 = (await remember(s1, "northwind", {
    title: "Use shared money helpers",
    body: "For Northwind invoice totals, call money.round() instead of Math.round.",
    sources: [{ uri: "northwind/docs/adr-12.md", hash: "7c2e10", kind: "doc" }],
    parents: [e1.id],
    derivation: "inferred",
    step: 9,
  })).data;
  e3 = (await remember(s1, "northwind", {
    title: "Enterprise discount terms",
    body: "Northwind's enterprise discount is 18% on three-year terms.",
    sources: [{ uri: "northwind/pricing-memo.pdf", hash: "9d01aa", kind: "doc" }],
    derivation: "stated",
    step: 12,
  })).data;
  c1 = (await remember(s2, "contoso", {
    title: "Invoices in EUR",
    body: "Contoso bills in EUR; convert at the booking date with fx.rateAt().",
    sources: [{ uri: "contoso/fx.ts", hash: "be44f0", kind: "file" }],
    step: 3,
  })).data;
  assert.deepEqual(e2.parents, [e1.id]);
});

await test("an agent can't write into another matter", async () => {
  const r = await remember(s2, "northwind", { title: "x", body: "y" });
  assert.equal(r.status, 403);
});

await test("cross-matter recall is denied and audited without leaking content", async () => {
  const r = await post("/recall", { session: s2.id, scope: "northwind", query: "discount" });
  assert.equal(r.status, 403);
  assert.ok(!JSON.stringify(r.data).includes("18%"));
  const g = (await get("/graph")).data;
  assert.ok(g.audit.some((a) => a.outcome === "denied" && a.scope === "contoso"), "denial logged in caller's scope");
});

await test("recall stays inside the session's matter and writes receipts", async () => {
  const r = (await post("/recall", { session: s1.id, query: "invoice totals rounding money", step: 15 })).data;
  const ids = r.results.map((e) => e.id);
  assert.ok(ids.includes(e2.id));
  assert.ok(!ids.includes(c1.id));
  const r2 = (await post("/recall", { session: s2.id, query: "invoice totals EUR", step: 6 })).data;
  assert.ok(r2.results.every((e) => !e.id.startsWith("n-")), "Contoso never sees Northwind entries");
  await post("/changes", { session: s1.id, ref: "PR #418", title: "Route totals through money.round" });
});

await test("why walks back through parents to sources", async () => {
  const w = (await get(`/why/northwind/${e2.id}`)).data;
  assert.deepEqual(w.chain.map((e) => e.id), [e2.id, e1.id]);
  assert.ok(w.chain[1].sources.some((s) => s.uri === "northwind/billing/round.ts"));
});

await test("impact walks forward to sessions and merged changes", async () => {
  const i = (await get(`/impact/northwind/${e1.id}`)).data;
  assert.ok(i.derived.includes(e2.id));
  assert.ok(i.recalledBy.some((r) => r.session === s1.id));
  assert.ok(i.changes.some((c) => c.ref === "PR #418"));
});

let p1, p2;
await test("remove by source quarantines what it taught, transitively", async () => {
  p1 = (await remember(s1, "northwind", {
    title: "Billing tests are flaky",
    body: "Tests in /billing are flaky; skip them when CI is red.",
    sources: [{ uri: "ci-note://883", kind: "note" }],
    derivation: "stated",
    step: 20,
  })).data;
  p2 = (await remember(s1, "northwind", { title: "Skip billing suite", body: "Mark billing tests as skipped to keep CI green.", parents: [p1.id], step: 22 })).data;
  await post("/recall", { session: s1.id, query: "billing tests flaky skip", step: 23 });
  await post("/changes", { session: s1.id, ref: "PR #420", title: "Skip billing tests in CI" });
  const out = (await post("/remove-source", { scope: "northwind", uri: "ci-note://883" })).data;
  assert.deepEqual(out.quarantined.sort(), [p1.id, p2.id].sort());
  assert.ok(out.changes.some((c) => c.ref === "PR #420"), "shows the change it influenced");
  const again = (await post("/recall", { session: s1.id, query: "billing tests flaky skip", step: 24 })).data;
  assert.ok(!again.results.some((e) => e.id === p1.id || e.id === p2.id), "quarantined entries no longer recalled");
  const h = (await get(`/history/northwind/${p1.id}`)).data;
  assert.equal(h.at(-1).status, "quarantined");
});

await test("promotion de-identifies and needs review before crossing", async () => {
  const review = (await post("/promote", { scope: "northwind", entry: e2.id })).data;
  assert.equal(review.status, "pending");
  assert.ok(!review.proposed.includes("Northwind"), "client name stripped");
  const before = (await post("/recall", { session: s2.id, query: "money helpers rounding", step: 9 })).data;
  assert.ok(!before.results.some((e) => e.advisory), "nothing crosses before approval");
  const decided = (await post(`/reviews/${review.id}`, { approve: true, reviewer: "Jordan" })).data;
  assert.equal(decided.entry.trust, "reviewed");
  assert.ok(decided.entry.sources[0].uri.startsWith("matter:"), "provenance points to a matter, not the client");
  const after = (await post("/recall", { session: s2.id, query: "money helpers rounding", step: 10 })).data;
  const adv = after.results.find((e) => e.advisory);
  assert.ok(adv && !adv.body.includes("Northwind"), "Contoso sees de-identified advisory precedent");
});

await test("figures are stripped too", async () => {
  const review = (await post("/promote", { scope: "northwind", entry: e3.id })).data;
  assert.ok(!review.proposed.includes("18%"));
  await post(`/reviews/${review.id}`, { approve: false, reviewer: "Jordan" });
});

await test("secrets are rejected, never stored", async () => {
  const r = await remember(s1, "northwind", { title: "Deploy key", body: "Use api_key=sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0 for staging.", sources: [{ uri: "northwind/.env" }] });
  assert.equal(r.status, 422);
  const g = (await get("/graph")).data;
  assert.ok(!JSON.stringify(g).includes("sk-live"), "nothing of the secret is stored or logged");
});

await test("every entry is signed over its origin and source versions", async () => {
  const v = (await get(`/verify/northwind/${e1.id}`)).data;
  assert.equal(v.valid, true);
  assert.match(v.signature, /^[0-9a-f]{64}$/);
});

let conflictId, s4, contra;
await test("two sessions that disagree are both marked contested", async () => {
  s4 = (await post("/sessions", { scope: "northwind", agent: "Agent 3 (cursor)", supervisor: "Casey" })).data;
  contra = (await remember(s4, "northwind", {
    title: "Avoid money helpers for invoice totals",
    body: "For Northwind invoice totals, do not call money.round(); it truncates. Use Math.round instead.",
    sources: [{ uri: "northwind/billing/round.ts", hash: "a41c9e", kind: "file" }],
    derivation: "inferred",
    step: 5,
  })).data;
  assert.equal(contra.status, "contested");
  assert.equal(contra.conflict.with, e2.id);
  conflictId = contra.conflict.id;
  const other = (await get(`/why/northwind/${e2.id}`)).data.entry;
  assert.equal(other.status, "contested");
  const rec = (await post("/recall", { session: s1.id, query: "invoice totals money round", step: 16 })).data;
  const flagged = rec.results.find((x) => x.id === e2.id);
  assert.ok(flagged && flagged.status === "contested", "contested entries are still recalled, flagged");
});

await test("a reviewer resolves the conflict, and the decision is history", async () => {
  const out = (await post(`/conflicts/${conflictId}`, { scope: "northwind", decision: "keep_a", reviewer: "Jordan", note: "money.round rounds half-even; it does not truncate" })).data;
  assert.deepEqual(out.kept, [e2.id]);
  assert.deepEqual(out.retracted, [contra.id]);
  const h = (await get(`/history/northwind/${contra.id}`)).data;
  assert.equal(h.at(-1).status, "retracted");
  assert.match(h.at(-1).note, /resolved by Jordan/);
});

await test("when a source changes, what it taught is flagged stale, transitively", async () => {
  const out = (await post("/source-changed", { scope: "northwind", uri: "northwind/billing/round.ts", hash: "b77f00" })).data;
  assert.ok(out.flagged.includes(e1.id) && out.flagged.includes(e2.id), "e1 cites it, e2 builds on e1");
  assert.ok(out.changes.some((c) => c.ref === "PR #418"), "lists the change to re-check");
  const rv = (await post("/reverify", { scope: "northwind", entry: e1.id, reviewer: "Avery", sources: [{ uri: "northwind/billing/round.ts", hash: "b77f00", kind: "file" }] })).data;
  assert.equal(rv.entry.status, "active");
  assert.ok(rv.entry.sources.some((x) => x.hash === "b77f00"));
  assert.equal((await get(`/verify/northwind/${e1.id}`)).data.valid, true, "re-signed after re-verification");
});

await test("export produces an OKF-style bundle", async () => {
  const b = (await get("/export/northwind")).data;
  const f = b.files.find((x) => x.path === `entries/${e1.id}.md`);
  assert.ok(f && /^---\ntype: /.test(f.content) && f.content.includes("attestation:") && f.content.includes("hash: \"b77f00\""));
  assert.ok(b.files.some((x) => x.path === "log.md") && b.files.some((x) => x.path === "index.md"));
});

await test("agents use the same memory over MCP, with the same rules", async () => {
  const mcp = async (method, params, id = 1) => (await fetch(`${BASE}/mcp/${demo}/${s2.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json();
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  assert.equal(init.result.serverInfo.name, "trust");
  const tools = await mcp("tools/list", {});
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ["memory_impact", "memory_recall", "memory_remember", "memory_retract", "memory_why"]);
  const wrote = await mcp("tools/call", { name: "memory_remember", arguments: { title: "Webhook signatures", body: "Verify Contoso webhook signatures before deduping.", sources: [{ uri: "contoso/webhooks.ts", hash: "9a1b2c" }], step: 12 } });
  const entry = JSON.parse(wrote.result.content[0].text);
  assert.equal(entry.origin.session, s2.id, "origin from the MCP session");
  const rec = await mcp("tools/call", { name: "memory_recall", arguments: { query: "discount enterprise terms" } });
  assert.ok(!rec.result.content[0].text.includes("18%"), "MCP recall can't see Northwind");
});

await test("a new wall pauses the live session on its next call", async () => {
  const w = (await post("/walls", { supervisor: "Avery", scope: "northwind", reason: "Avery joined Contoso work" })).data;
  assert.deepEqual(w.paused, [s1.id]);
  const r = await post("/recall", { session: s1.id, query: "rounding" });
  assert.equal(r.status, 403);
  const again = await post("/sessions", { scope: "northwind", agent: "claude-code", supervisor: "Avery" });
  assert.equal(again.status, 400, "walled supervisor can't start a new session there");
});

await test("rollback by session quarantines what it wrote", async () => {
  const s3 = (await post("/sessions", { scope: "contoso", agent: "codex", supervisor: "Blake" })).data;
  const bad = (await remember(s3, "contoso", { title: "Wrong FX rule", body: "Convert EUR at invoice date.", sources: [{ uri: "contoso/notes.md" }] })).data;
  const out = (await post("/rollback", { scope: "contoso", session: s3.id })).data;
  assert.deepEqual(out.quarantined, [bad.id]);
});

await test("graph endpoint returns every scope", async () => {
  const g = (await get("/graph")).data;
  assert.ok(g.graphs.northwind.entries.length >= 5 && g.graphs.contoso.entries.length >= 1 && g.graphs.precedent.entries.length === 1);
});

// ---------- judge: dedupe, supersede, trust rule (default heuristic judge) ----------
// A fresh demo: the one above has a wall on Northwind by now.
const firstDemo = demo;
demo = (await api("POST", "/demo")).data.demo;
const j1 = (await post("/sessions", { scope: "contoso", agent: "claude-code", supervisor: "Casey" })).data;
const j2 = (await post("/sessions", { scope: "contoso", agent: "codex", supervisor: "Drew" })).data;
let base;

await test("a duplicate write becomes corroboration on the existing entry", async () => {
  base = (await remember(j1, "contoso", { title: "Contoso invoices use EUR", body: "Contoso invoices are issued in EUR from the Dublin entity.", sources: [{ uri: "contoso/billing/config.ts", hash: "aa11" }], step: 1 })).data;
  const dup = (await remember(j2, "contoso", { title: "Contoso invoices use EUR", body: "Contoso invoices are issued in EUR from the Dublin entity.", sources: [{ uri: "contoso/billing/config.ts", hash: "aa11" }, { uri: "contoso/contract.pdf", kind: "doc" }], step: 3 })).data;
  assert.equal(dup.id, base.id, "no new entry");
  assert.equal(dup.deduped.into, base.id);
  assert.equal(dup.corroborations.length, 1);
  assert.equal(dup.corroborations[0].session, j2.id, "the second agent's origin is kept");
  assert.equal(dup.sources.length, 2, "the new source joins the entry");
  assert.equal(dup.version, 2);
  assert.equal((await get(`/verify/contoso/${base.id}`)).data.valid, true, "re-signed after corroboration");
  const h = (await get(`/history/contoso/${base.id}`)).data;
  assert.match(h.at(-1).note, /corroborated by codex/);
});

await test("a write that adds a figure is kept, not merged", async () => {
  const r = (await remember(j2, "contoso", { title: "Contoso invoices use EUR", body: "Contoso invoices are issued in EUR from the Dublin entity, net 45.", sources: [{ uri: "contoso/billing/config.ts", hash: "aa11" }], step: 4 })).data;
  assert.ok(!r.deduped);
});

await test("a sourced change supersedes the agent's own older memory", async () => {
  const old = (await remember(j1, "contoso", { title: "Contoso FX rate source", body: "Contoso FX conversions use the ECB daily reference rate.", sources: [{ uri: "contoso/fx.ts", hash: "f1" }], step: 5 })).data;
  const neu = (await remember(j1, "contoso", { title: "Contoso FX rate source changed", body: "Contoso FX conversions now use the Bloomberg BFIX rate; the ECB daily reference rate was retired.", sources: [{ uri: "contoso/fx.ts", hash: "f2" }], step: 6 })).data;
  const o = (await get(`/why/contoso/${old.id}`)).data.entry;
  assert.equal(o.status, "superseded");
  assert.equal(o.superseded_by, neu.id);
  const rec = (await post("/recall", { session: j2.id, query: "Contoso FX rate source", step: 7 })).data.results.filter((e) => !e.advisory);
  assert.equal(rec[0].id, neu.id, "the current fact ranks first");
});

await test("an unsourced write can't retire a sourced memory; it goes to review", async () => {
  const sourced = (await remember(j1, "contoso", { title: "Contoso support hours", body: "Contoso's support desk is staffed 8am to 6pm CET on weekdays.", sources: [{ uri: "contoso/sla.pdf", hash: "m1" }], step: 8 })).data;
  const claim = (await remember(j2, "contoso", { title: "Contoso support hours changed", body: "Contoso's support desk is now staffed 8am to 6pm CET on weekdays and Saturdays.", step: 9 })).data;
  const a = (await get(`/why/contoso/${sourced.id}`)).data.entry;
  assert.notEqual(a.status, "superseded");
  assert.equal(a.status, "contested");
  assert.equal(claim.conflict?.with, sourced.id);
});

await test("every judgment is logged with the judge that made it", async () => {
  const rel = (await get("/relations/contoso")).data;
  assert.ok(rel.some((r) => r.action === "merged" && r.b === base.id));
  assert.ok(rel.some((r) => r.action === "superseded"));
  assert.ok(rel.every((r) => r.judge));
});

await test("the judge endpoint scores a pair without storing it", async () => {
  const out = (await post("/judge", { newer: { title: "Logs kept 90 days", body: "Application logs are retained for 90 days." }, older: [{ title: "Logs kept 30 days", body: "Application logs are retained for 30 days." }] })).data;
  assert.equal(out.length, 1);
  assert.equal(out[0].relation, "contradicts");
});

console.log(`\n${passed} passed (demos ${firstDemo}, ${demo})`);
