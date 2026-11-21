# Judge eval

Trust asks a judge how each new memory relates to the memories already in its scope, then acts on the answer: merge a duplicate as corroboration, send a contradiction to review, retire a superseded memory. This folder holds hand-labeled gold data and a scorer, so judges can be compared and thresholds set from evidence rather than guesses.

## What's here

| File | What it is |
| --- | --- |
| `gold/pairs.jsonl` | Core set: 100 labeled pairs (older memory, newer memory, relation), 20 per relation, across code, ops, legal, preferences and research. 47 are marked `hard`. Each has a one-line `why`. |
| `gold/pairs-hard.jsonl` | Hard set: 60 pairs built to separate strong models. Each tricky item names its `trap`: `near-duplicate` (identical except one material detail, so a merge would lose it), `implication` (the conflict only follows from what the claim implies), `multi-fact` (one of several facts differs), `units` (35 days vs five weeks), `same-entity` (same subject, different fact), `negation`. |
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

For a memory with several facts, the newer one is labeled by what it does to the whole: if it restates everything and one fact differs with a sign of change, it `supersedes`; with no sign of change, it `contradicts`; if it keeps everything and adds a fact, it `refines`.

The hard line is between supersedes and contradicts. With no sign of change ("now", "since v2", "amended", "replaced"), the label is `contradicts`, because a reviewer should decide which one is right.

## Bars

A judgment only changes something when its confidence clears the bar for its relation. Model judges default to duplicate 0.75, supersedes 0.7, contradicts 0.5. Those defaults come from the first Jev run: every correct supersede scored 0.80 or more, and two real contradictions scored 0.62 and 0.74. The heuristic keeps supersedes at 0.5, because its confidences are fixed numbers rather than probabilities, and it merges only identical text.

Override them per deployment with `TRUST_JUDGE_THRESHOLDS`, flat (`{"duplicate":0.8}`) or per judge (`{"workers-ai:clef-flash":{"supersedes":0.8}}`). The scorer reads the bars from the Worker and ends with a calibration table: how each bar performs, and the lowest bar above which every prediction was right. Set each model's bars from its own run.

## The unsure band

Judgments under 0.55, or under their relation's bar, don't act. They come back to the agent as notes, with a second model's reading if one is configured, and the agent decides. The scorer lists them as "sent to the agent as unsure" and shows which costly misses the agent was told about. On the Jev runs that's 8 of 160 pairs, covering all 6 misses that mattered: 2 contradictions read as refines at 0.50-0.51, a supersede at 0.52, and three merges skipped at 0.54-0.69.

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

A full run is 160 judge calls plus about 30 writes, roughly 60,000 input tokens. `--set core` or `--set hard` runs one set.

## Results so far

| Judge | Pair accuracy | Macro-F1 | Harmful merges | Missed conflicts | Tasks |
| --- | --- | --- | --- | --- | --- |
| Oracle (gold labels) | 100% | 100% | 0 | 0 | 12/12 |
| Jev (`jev-latest`), core set | 98% | 98% | 0 | 0 | 12/12 |
| Jev (`jev-latest`), hard set | 93% | 94% | 0 | 2 of 14 | |
| Heuristic, core set | 58% | 56.5% | 0 | 12 of 20 | 8/12 |
| Heuristic, hard set | 48% | 47% | 0 | 12 of 14 | |
| Clef-Flash | not run yet | | | | |
| Kev | not run yet | | | | |

Jev's two misses were both labeled `refines` when gold said otherwise (one duplicate, one unrelated), and both in the preferences domain. Refines keeps both memories, so neither error changed anything stored. Median judge latency was 64 ms from a laptop to TypeSafe's API. A score this close to the oracle mostly says the set is too easy for a strong model: the next step is harder pairs and pairs from real traffic, not more tuning.

The oracle passing everything shows that the write policy, the System One adapter and the task checks are consistent. The judge is the only thing left to measure.

The heuristic catches explicit changes and figure swaps (supersedes F1 86%) and almost never invents a relation between unrelated memories. It can't recognise paraphrases (duplicate recall 25%), so it rarely merges, which is the safe failure. It misses contradictions that don't use a negation word or a different number ("Delaware law" vs "New York law", "Thursday" vs "Monday"). Those two gaps are what a model judge is for.

## Caveats

- **One annotator.** Claude wrote and labeled every item. Before using these numbers to choose thresholds, have someone read the 47 `hard` items and the `why` lines and correct any labels they disagree with.
- **Synthetic.** The memories are realistic but invented. Where they mention real products, they're used only as fixtures. Add pairs from real Mergery and Trust traffic as it builds up.
- **The heuristic was tuned against the core set.** After the first run (34%), it got generic fixes: containment overlap for short memories, a check for figures that differ, and a broader list of change words. It then scored 58%. After the hard set showed it merging near-duplicates, it was limited to merging identical text. Treat its numbers as optimistic. Model judges have not seen either set.
- **Small.** With 20 items per label, a single item moves per-label recall by 5 points.
