#!/usr/bin/env bash
# The checks that run on every push (and locally: `npm run ci`).
#   1. End-to-end checks against a local Worker with the heuristic judge.
#   2. Heuristic eval: no wrong merges or retirements, and no task regressions.
#   3. Oracle eval: a judge that answers from the gold labels must score 100% and pass every
#      task, which proves the write policy, the System One adapter and the gold data agree.
# No Cloudflare login or model is needed: the Worker runs without the Workers AI binding.
set -euo pipefail
cd "$(dirname "$0")/.."

export WRANGLER_SEND_METRICS=false
# A low per-visitor limit, so the e2e checks can hit it.
export TRUST_SPACES_PER_IP=3
# Sign-in without GitHub, with a throwaway cookie key, so the ownership checks run.
export TRUST_DEV_LOGIN=1
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_for() { # url, log file
  for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "Timed out waiting for $1"; tail -50 "$2"; exit 1
}

node scripts/offline-config.mjs

echo "== Worker with the heuristic judge"
npx wrangler dev -c .wrangler.offline.jsonc --port 8787 --var TRUST_JUDGE:heuristic --var "TRUST_SPACES_PER_IP:$TRUST_SPACES_PER_IP" --var TRUST_DEV_LOGIN:1 --var "TRUST_SESSION_KEY:ci-$RANDOM-$RANDOM-$RANDOM" > /tmp/trust-heuristic.log 2>&1 &
PIDS+=($!)
wait_for http://localhost:8787/ /tmp/trust-heuristic.log

echo "== End-to-end checks"
BASE_URL=http://localhost:8787 node test/e2e.mjs

echo "== Heuristic eval"
BASE_URL=http://localhost:8787 node eval/score.mjs --no-save --max-costly 0 --min-tasks 8
cleanup; PIDS=(); sleep 2

echo "== Demo and /new turned off (TRUST_DISABLE_DEMO=1, TRUST_DISABLE_NEW=1)"
npx wrangler dev -c .wrangler.offline.jsonc --port 8790 --var TRUST_JUDGE:heuristic --var TRUST_DISABLE_DEMO:1 --var TRUST_DISABLE_NEW:1 > /tmp/trust-disabled.log 2>&1 &
PIDS+=($!)
wait_for http://localhost:8790/ /tmp/trust-disabled.log
BASE_URL=http://localhost:8790 node test/disabled.mjs
cleanup; PIDS=(); sleep 2

echo "== Oracle eval"
unset TRUST_SPACES_PER_IP TRUST_DEV_LOGIN
node eval/oracle.mjs > /tmp/trust-oracle.log 2>&1 &
PIDS+=($!)
npx wrangler dev -c .wrangler.offline.jsonc --port 8788 --var TRUST_JUDGE:systemone --var TRUST_JUDGE_URL:http://127.0.0.1:8799 --var TRUST_JUDGE_MODEL:oracle > /tmp/trust-oracle-worker.log 2>&1 &
PIDS+=($!)
wait_for http://localhost:8788/ /tmp/trust-oracle-worker.log
BASE_URL=http://localhost:8788 node eval/score.mjs --no-save --require-perfect

echo "== All checks passed"
