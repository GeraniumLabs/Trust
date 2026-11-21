#!/usr/bin/env node
// Unit tests for the judge adapters. Runs against a bundled copy of src/judge.ts and a local
// mock /v1/systemone server, so it needs no Cloudflare account and no model.
// Usage: npm run test:unit

import assert from "node:assert/strict";
import { createServer } from "node:http";

const J = await import(new URL("../.build/judge.mjs", import.meta.url));
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

const newer = { title: "Logs kept 90 days", body: "Application logs are retained for 90 days.", sources: ["infra/logging.tf"] };
const older = [
  { title: "Logs kept 30 days", body: "Application logs are retained for 30 days.", sources: ["infra/logging.tf"] },
  { title: "Docs site uses Astro", body: "The documentation site is built with Astro." },
];

// A mock System One server. `mode` decides how it answers the next request.
let mode = "ok";
let lastReq = null;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") };
    if (mode === "500") return res.writeHead(500).end("boom");
    if (mode === "slow") return setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 500);
    if (mode === "garbage") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answers: { rel_m0: { type: "choice", choice: "banana" } } }));
    const answers = {
      rel_m0: { type: "choice", choice: "contradicts", confidence: 0.91, probabilities: { duplicate: 0.02, refines: 0.03, supersedes: 0.03, contradicts: 0.91, unrelated: 0.01 } },
      rel_m1: { type: "choice", choice: "unrelated", confidence: 0.97, probabilities: { duplicate: 0, refines: 0.01, supersedes: 0.01, contradicts: 0.01, unrelated: 0.97 } },
    };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "kev-4b", answers, usage: { input_tokens: 300 } }));
  });
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

await test("one request carries every candidate as a choice question", async () => {
  const req = J.systemOneRequest("clef-flash", newer, older);
  assert.equal(req.model, "clef-flash");
  assert.deepEqual(Object.keys(req.questions), ["rel_m0", "rel_m1"]);
  assert.equal(req.questions.rel_m0.type, "choice");
  assert.deepEqual(Object.keys(req.questions.rel_m0.criteria), J.RELATIONS);
  assert.equal(req.state.new_memory.title, newer.title);
  assert.equal(req.state.existing.m1.title, older[1].title);
});

await test("SystemOneJudge posts to /v1/systemone with the key and parses answers", async () => {
  mode = "ok";
  const j = new J.SystemOneJudge(`${base}/`, "kev-4b", "test-key", 2000);
  const out = await j.judge(newer, older);
  assert.equal(lastReq.url, "/v1/systemone");
  assert.equal(lastReq.auth, "Bearer test-key");
  assert.equal(lastReq.body.model, "kev-4b");
  assert.equal(out[0].relation, "contradicts");
  assert.equal(out[0].confidence, 0.91);
  assert.equal(out[0].judge, "systemone:kev-4b");
  assert.equal(out[1].relation, "unrelated");
  assert.ok(!out[0].fallback);
});

await test("a base URL that already ends in /v1/systemone still works", async () => {
  mode = "ok";
  await new J.SystemOneJudge(`${base}/v1/systemone`, "jev").judge(newer, older);
  assert.equal(lastReq.url, "/v1/systemone");
  assert.equal(lastReq.auth, undefined, "no key, no header");
});

for (const [m, why] of [["500", /HTTP 500/], ["slow", /timed out/], ["garbage", /invalid answer/]]) {
  await test(`a ${m} response falls back to the heuristic and says why`, async () => {
    mode = m;
    const out = await new J.SystemOneJudge(base, "kev-4b", undefined, 200).judge(newer, older);
    assert.equal(out.length, 2);
    assert.equal(out[0].judge, "heuristic");
    assert.match(out[0].fallback, why);
  });
}

await test("WorkersAIJudge calls the binding with the model id and selector", async () => {
  let call;
  const ai = { run: async (model, input) => ((call = { model, input }), { answers: { rel_m0: { type: "choice", choice: "duplicate", confidence: 0.88, probabilities: { duplicate: 0.88 } } } }) };
  const out = await new J.WorkersAIJudge(ai).judge(newer, older.slice(0, 1));
  assert.equal(call.model, "@cf/cloudflare/clef-flash");
  assert.equal(call.input.model, "clef-flash");
  assert.equal(out[0].judge, "workers-ai:clef-flash");
  assert.equal(out[0].relation, "duplicate");
  assert.equal(out[0].probabilities.refines, 0, "missing probabilities read as 0");
});

await test("makeJudge picks the backend from config", async () => {
  const ai = { run: async () => ({}) };
  assert.equal(J.makeJudge({}).name, "heuristic");
  assert.equal(J.makeJudge({ AI: ai }).name, "workers-ai:clef-flash");
  assert.equal(J.makeJudge({ AI: ai, TRUST_JUDGE_MODEL: "@cf/cloudflare/clef" }).name, "workers-ai:clef");
  assert.equal(J.makeJudge({ AI: ai, TRUST_JUDGE: "heuristic" }).name, "heuristic");
  assert.equal(J.makeJudge({ TRUST_JUDGE_URL: base }).name, "systemone:kev-4b");
  assert.equal(J.makeJudge({ AI: ai, TRUST_JUDGE: "systemone", TRUST_JUDGE_URL: base, TRUST_JUDGE_MODEL: "jev" }).name, "systemone:jev");
});

await test("the heuristic never clears the merge bar when figures differ or are added", async () => {
  const swap = J.heuristicRelation(newer, older[0]);
  assert.equal(swap.relation, "contradicts");
  const added = J.heuristicRelation({ title: "Logs kept 30 days", body: "Application logs are retained for 30 days, 365 for audit logs." }, older[0]);
  assert.notEqual(added.relation, "duplicate");
});

await test("thresholds: each model has its own profile; unknown models get the defaults", async () => {
  assert.equal(J.thresholdsFor("systemone:jev-latest").supersedes, 0.7);
  assert.equal(J.thresholdsFor("systemone:jev-1.13").duplicate, 0.75);
  assert.equal(J.thresholdsFor("workers-ai:clef-flash").duplicate, 0.45);
  assert.equal(J.thresholdsFor("systemone:clef-flash").contradicts, 0.2, "self-hosted Clef-Flash gets the same profile");
  assert.equal(J.thresholdsFor("workers-ai:clef").supersedes, 0.55);
  assert.equal(J.thresholdsFor("systemone:kev-4b").duplicate, 0.75, "not yet scored: defaults");
  assert.equal(J.thresholdsFor("heuristic").supersedes, 0.5);
  assert.equal(J.unsureBelow({}, "workers-ai:clef-flash"), 0.25);
  assert.equal(J.unsureBelow({}, "workers-ai:clef"), 0.35);
  assert.equal(J.unsureBelow({}, "systemone:kev-4b"), 0.55);
  assert.equal(J.unsureBelow({ TRUST_JUDGE_UNSURE_BELOW: "0.4" }, "workers-ai:clef-flash"), 0.4, "explicit setting wins");
  assert.equal(J.unsureBelow({ TRUST_JUDGE_THRESHOLDS: JSON.stringify({ "workers-ai:clef-flash": { unsure: 0.3 } }) }, "workers-ai:clef-flash"), 0.3);
});

await test("thresholds: overrides apply flat or per judge, and bad values are ignored", async () => {
  const env = { TRUST_JUDGE_THRESHOLDS: JSON.stringify({ duplicate: 0.8, "workers-ai:clef-flash": { supersedes: 0.85 }, contradicts: 7 }) };
  assert.equal(J.thresholdsFor("systemone:kev-4b", env).duplicate, 0.8);
  assert.equal(J.thresholdsFor("systemone:kev-4b", env).supersedes, 0.7);
  assert.equal(J.thresholdsFor("workers-ai:clef-flash", env).supersedes, 0.85);
  assert.equal(J.thresholdsFor("workers-ai:clef-flash", env).contradicts, 0.2, "out-of-range value falls back to the profile");
  assert.equal(J.thresholdsFor("workers-ai:clef-flash", env).duplicate, 0.8, "flat override beats the profile");
  assert.equal(J.thresholdsFor("heuristic", env).duplicate, 0.75, "overrides never touch the heuristic");
  assert.equal(J.thresholdsFor("systemone:x", { TRUST_JUDGE_THRESHOLDS: "{not json" }).supersedes, 0.7);
});

await test("unsure: low confidence, or an action that didn't clear its bar", async () => {
  const j = (relation, confidence, judge = "systemone:jev-latest") => ({ relation, confidence, judge });
  assert.equal(J.isUnsure(j("refines", 0.5)), true, "h-con-01 shape: refines at 0.50");
  assert.equal(J.isUnsure(j("supersedes", 0.52)), true, "h-sup-01 shape");
  assert.equal(J.isUnsure(j("supersedes", 0.65)), true, "above 0.55 but under the 0.7 bar");
  assert.equal(J.isUnsure(j("duplicate", 0.69)), true);
  assert.equal(J.isUnsure(j("refines", 0.79)), false);
  assert.equal(J.isUnsure(j("unrelated", 0.9)), false);
  assert.equal(J.isUnsure(j("contradicts", 0.6)), false, "cleared its bar: acted on, not unsure");
  assert.equal(J.isUnsure(j("refines", 0.6), { TRUST_JUDGE_UNSURE_BELOW: "0.7" }), true);
  assert.equal(J.isUnsure(j("contradicts", 0.22, "workers-ai:clef-flash")), false, "clears Clef-Flash's 0.20 bar");
  assert.equal(J.isUnsure(j("contradicts", 0.15, "workers-ai:clef-flash")), true);
});

await test("second opinion: built from its own settings, never the heuristic", async () => {
  const ai = { run: async () => ({}) };
  assert.equal(J.makeSecondJudge({}), null);
  assert.equal(J.makeSecondJudge({ TRUST_JUDGE_SECOND: "workers-ai", AI: ai, TRUST_JUDGE_SECOND_MODEL: "@cf/cloudflare/clef" }).name, "workers-ai:clef");
  assert.equal(J.makeSecondJudge({ TRUST_JUDGE_SECOND: "systemone", TRUST_JUDGE_SECOND_URL: base, TRUST_JUDGE_SECOND_MODEL: "jev-latest" }).name, "systemone:jev-latest");
  assert.equal(J.makeSecondJudge({ TRUST_JUDGE_SECOND: "workers-ai" }), null, "no binding: no second opinion");
});

await test("resolveJudge warns when the requested judge can't be built", async () => {
  assert.match(J.resolveJudge({ TRUST_JUDGE: "workers-ai" }).warning, /no Workers AI binding/);
  assert.match(J.resolveJudge({ TRUST_JUDGE: "systemone" }).warning, /TRUST_JUDGE_URL/);
  assert.equal(J.resolveJudge({}).warning, null, "auto with nothing configured is a quiet heuristic");
  assert.equal(J.resolveJudge({ TRUST_JUDGE: "workers-ai", AI: { run: async () => ({}) } }).warning, null);
});

server.close();
console.log(`\n${passed} passed`);
