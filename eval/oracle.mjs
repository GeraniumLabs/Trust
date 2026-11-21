#!/usr/bin/env node
// Oracle judge: a /v1/systemone server that answers from the gold labels. Point a Worker at
// it to check Trust's write policy (merge, conflict, supersede, trust rule) with a perfect
// judge. If a task fails here, the policy or the task is wrong, not the model.
//
//   node eval/oracle.mjs                      # listens on :8799
//   npx wrangler dev --port 8788 --var TRUST_JUDGE:systemone --var TRUST_JUDGE_URL:http://127.0.0.1:8799 --var TRUST_JUDGE_MODEL:oracle
//   BASE_URL=http://localhost:8788 node eval/score.mjs --label oracle

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const key = (newer, older) => `${newer.trim()}\u0000${older.trim()}`;
const gold = new Map();
for (const file of ["gold/pairs.jsonl", "gold/pairs-hard.jsonl"])
  for (const line of readFileSync(new URL(file, here), "utf8").trim().split("\n")) {
    const p = JSON.parse(line);
    gold.set(key(p.newer.title, p.older.title), p.label);
  }
const { tasks } = JSON.parse(readFileSync(new URL("gold/tasks.json", here), "utf8"));
for (const t of tasks) {
  const title = Object.fromEntries(t.steps.map((s) => [s.key, s.title]));
  for (const s of t.steps) for (const [k, rel] of Object.entries(s.gold ?? {})) gold.set(key(s.title, title[k]), rel);
}

const LABELS = ["duplicate", "refines", "supersedes", "contradicts", "unrelated"];
const port = Number(process.env.PORT ?? 8799);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = JSON.parse(body || "{}");
    const answers = {};
    for (const [qid] of Object.entries(r.questions ?? {})) {
      const m = r.state.existing[qid.replace(/^rel_/, "")];
      const choice = gold.get(key(r.state.new_memory.title, m.title)) ?? "unrelated";
      answers[qid] = { type: "choice", choice, confidence: 0.99, probabilities: Object.fromEntries(LABELS.map((l) => [l, l === choice ? 0.99 : 0.0025])) };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "oracle", answers }));
  });
}).listen(port, () => console.log(`oracle judge on http://127.0.0.1:${port}/v1/systemone (${gold.size} labeled pairs)`));
