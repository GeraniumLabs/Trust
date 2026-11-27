#!/usr/bin/env node
// End-to-end checks for a Worker running with the open site turned off
// (TRUST_DISABLE_DEMO=1 TRUST_DISABLE_NEW=1), as scripts/ci.sh starts it.
// test/e2e.mjs checks the other side: with both unset, everything behaves as before.
// Usage: BASE_URL=http://localhost:8787 node test/disabled.mjs

import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await test("POST /api/demo answers 404", async () => {
  const r = await api("POST", "/demo");
  assert.equal(r.status, 404);
  assert.match(r.data.error, /not found/i);
});

await test("/new answers 404 at every path it lives at", async () => {
  for (const p of ["/new", "/new/", "/new/index.html"]) {
    const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
    assert.equal(r.status, 404, p);
  }
});

await test("the rest of the server is untouched", async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200, "the landing page is still served");
  assert.equal((await fetch(`${BASE}/try/`)).status, 200, "so is the demo");
  // From the operator's own Worker (no CF-Connecting-IP), persistent spaces still work.
  const made = await api("POST", "/spaces", { name: "no demos", scopes: [{ id: "project", kind: "project" }] });
  assert.equal(made.status, 200, "the operator's own Worker still makes spaces");
  assert.match(made.data.adminToken, /^trust_adm_/);
  const sess = await api("POST", `/spaces/${made.data.space}/sessions`, { scope: "project", agent: "e2e", supervisor: "ci" }, made.data.adminToken);
  assert.equal(sess.status, 200, "and its API still answers");
  await api("DELETE", `/spaces/${made.data.space}?confirm=${made.data.space}`, undefined, made.data.adminToken);
});

console.log(`\n${passed} passed (TRUST_DISABLE_DEMO and TRUST_DISABLE_NEW both set)`);
