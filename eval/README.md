# Judge eval

Trust asks a judge how each new memory relates to the memories already in its scope, then acts on the answer: merge a duplicate as corroboration, send a contradiction to review, retire a superseded memory. This folder holds hand-labeled gold data and a scorer, so judges can be compared and thresholds set from evidence rather than guesses.

## What's here

| File | What it is |
| --- | --- |
| `gold/pairs.jsonl` | 100 labeled pairs (older memory, newer memory, relation), 20 per relation, across code, ops, legal, preferences and research. 47 are marked `hard`. Each has a one-line `why`. |
| `gold/tasks.json` | 12 scenario tasks. Agents write memories through the real API, then the end state is checked: entry count, merges, statuses, open conflicts, corroborations, and what recall ranks first. Each step carries its `gold` relations. |
| `score.mjs` | Runs both against a Worker and prints accuracy, per-label precision/recall/F1, a confusion matrix, costly mistakes and latency. Writes `results/<label>.json`. |
| `oracle.mjs` | A `/v1/systemone` server that answers from the gold labels. It tests Trust's write policy with a perfect judge. |
| `results/` | Saved runs. |

## Labels

| Label | Meaning | Trust does |
| --- | --- | --- |
| `duplicate` | Same fact or instruction. Rewording, rounding or an extra citation adds nothing a reader would act on. | Merges the write into the existing entry as corroboration: its origin and sources join, and the body stays the same. The bar is 0.75 confidence. |
| `refines` | Agrees and adds detail, scope, a condition or an exception. Both stay true. | Keeps both and logs the relation. |
| `supersedes` | The older one was true; the newer one says it changed: a migration, a new version, an amendment, a new order. | Marks the older entry `superseded`, which ranks it last in recall. If the write has lower trust than the old entry, it opens a review instead. |
| `contradicts` | Same current situation, can't both be true, and nothing says it changed over time. | Marks both `contested` and opens a conflict for review (across sessions only). |
| `unrelated` | Different subject, even when words overlap. | Nothing. |

The hard line is between supersedes and contradicts. With no sign of change ("now", "since v2", "amended", "replaced"), the label is `contradicts`, because a reviewer should decide which one is right.

## Costly mistakes

Accuracy treats every error alike, so the scorer also lists four errors by their effect:

- **Harmful merges**: a non-duplicate merged into an existing entry. The new claim is folded away. This is the worst error, which is why duplicates need 0.75 confidence.
- **Wrongful supersedes**: a memory that was still true gets retired.
- **Missed conflicts**: a real disagreement nobody reviews.
- **False conflicts**: review noise.

## Running it

Start a Worker, then score it. The scorer measures whichever judge that Worker is configured with.

```sh
# Heuristic (no login, no model)
npm run dev:offline
node eval/score.mjs --label heuristic

# Clef-Flash on Workers AI (needs `wrangler login`; the AI binding is in wrangler.jsonc)
npm run dev
node eval/score.mjs --label clef-flash

# Clef (the larger model)
npx wrangler dev --var TRUST_JUDGE_MODEL:@cf/cloudflare/clef
node eval/score.mjs --label clef

# Any /v1/systemone endpoint: a local Kev on Ollama or llama.cpp, hosted Jev, OpenRouter...
npm run dev:offline -- --var TRUST_JUDGE:systemone --var TRUST_JUDGE_URL:http://127.0.0.1:11434 --var TRUST_JUDGE_MODEL:<model name>
node eval/score.mjs --label kev-4b

# The oracle (checks the write policy, not a model)
node eval/oracle.mjs &
npm run dev:offline -- --port 8788 --var TRUST_JUDGE:systemone --var TRUST_JUDGE_URL:http://127.0.0.1:8799 --var TRUST_JUDGE_MODEL:oracle
BASE_URL=http://localhost:8788 node eval/score.mjs --label oracle
```

A full run is 100 judge calls plus about 30 writes. On Clef-Flash that's roughly 40,000 input tokens.

## Results so far

| Judge | Pair accuracy | Macro-F1 | Harmful merges | Missed conflicts | Tasks |
| --- | --- | --- | --- | --- | --- |
| Oracle (gold labels) | 100% | 100% | 0 | 0 | 12/12 |
| Heuristic | 58% | 56.5% | 2 | 12 of 20 | 8/12 |
| Clef-Flash | not run yet | | | | |
| Kev | not run yet | | | | |

The oracle passing everything shows that the write policy, the System One adapter and the task checks are consistent. The judge is the only thing left to measure.

The heuristic catches explicit changes and figure swaps (supersedes F1 86%) and almost never invents a relation between unrelated memories. It can't recognise paraphrases (duplicate recall 25%), so it rarely merges, which is the safe failure. It misses contradictions that don't use a negation word or a different number ("Delaware law" vs "New York law", "Thursday" vs "Monday"). Those two gaps are what a model judge is for.

## Caveats

- **One annotator.** Claude wrote and labeled every item. Before using these numbers to choose thresholds, have someone read the 47 `hard` items and the `why` lines and correct any labels they disagree with.
- **Synthetic.** The memories are realistic but invented. Where they mention real products, they're used only as fixtures. Add pairs from real Mergery and Trust traffic as it builds up.
- **The heuristic was tuned once against this set.** After the first run (34%), it got generic fixes: containment overlap for short memories, a check for figures that differ, and a broader list of change words. It then scored 58%. Treat its number as optimistic. Model judges have not seen the set.
- **Small.** With 20 items per label, a single item moves per-label recall by 5 points.
