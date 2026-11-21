# Trust

Agent memory that knows where every memory came from.

Every memory Trust stores records its **origin** (which agent, session and step produced it, and who supervised) and its **sources** (the files, logs, documents or other memories it was drawn from, with content hashes). That makes memory explainable, scoped and reversible:

- **Why** does the agent believe this? Walk back to its sources.
- **What did it affect?** Recall receipts trace it forward to sessions and merged changes.
- **A source was wrong?** Remove it, and everything it taught, plus everything built on that, is quarantined.
- **Separate matters stay separate.** Each scope has its own store, every read is checked against walls on every call, and knowledge crosses only through a reviewed, de-identified promotion.
- **One fact, many witnesses.** A judge compares each write with its nearest neighbours. Duplicates become corroboration on the existing memory, contradictions go to review, and a sourced change retires the memory it replaces.

This repo is Trust v1 plus a public demo page, on Cloudflare Workers and Durable Objects (SQLite).

## Run it

```sh
npm install
npm run dev          # http://localhost:8787, with Clef-Flash as the judge (needs `wrangler login`)
npm run dev:offline  # same, without the Workers AI binding: heuristic judge, no login
npm test             # end-to-end checks against the dev server (BASE_URL to override)
npm run test:unit    # judge adapters against a mock /v1/systemone server
npm run eval         # score the running Worker's judge against the gold set (see eval/)
npm run deploy       # your own workers.dev URL, shareable as-is
```

## Architecture

| Part | Role |
| --- | --- |
| Worker (`src/index.ts`) | API router, serves the demo page from `public/` |
| Registry DO (`src/registry.ts`) | One per demo: scopes, sessions, walls, merged changes, audit trail. Authorizes every read and write |
| Scope DO (`src/scope.ts`) | One per scope: SQLite tables for entries, append-only versions, sources, derivation links, recall receipts, promotion reviews, judge relations, corroborations |
| Judge (`src/judge.ts`) | Decides how a new memory relates to existing ones. Speaks the System One API, so Clef, Clef-Flash, Kev and Jev are interchangeable |

Origin is attached by the server from the session. Agents can add sources but can't claim an origin. An entry with no sources is stored as `unverified`, the lowest trust tier.

## API (per demo: `/api/demo/:id/...`)

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/demo` | Create a throwaway demo (expires after an hour) |
| POST | `sessions` | Start a session bound to one scope |
| POST | `remember` | Write a memory with sources and parents |
| POST | `recall` | Search the session's scope, plus advisory precedent. Writes recall receipts |
| GET | `why/:scope/:id` | Chain back through parents to sources |
| GET | `impact/:scope/:id` | Derived memories, recalling sessions, changes merged after the recall |
| GET | `history/:scope/:id` | Every version of a memory |
| POST | `remove-source` | Quarantine everything a source taught, transitively |
| POST | `rollback` | Quarantine everything a session wrote |
| POST | `promote` | De-identify a memory and open a review |
| POST | `reviews/:id` | Approve or reject a promotion |
| POST | `walls` | Wall a supervisor off a scope. Pauses their live sessions |
| POST | `changes` | Record a merged change for a session |
| POST | `retract` | Retract a memory with a reason (stays in history) |
| POST | `source-changed` | A cited source moved to a new version: flag what it taught as stale, transitively |
| POST | `reverify` | Clear a stale flag after checking the memory against the new source version |
| GET / POST | `conflicts/:scope` / `conflicts/:id` | List conflicts, or resolve one: `keep_a`, `keep_b`, `keep_both`, `retract_both` |
| GET | `verify/:scope/:id` | Check a memory's signature over its origin and source versions |
| GET | `export/:scope` | The scope as an OKF-style bundle: one Markdown file per memory, plus `log.md` and `index.md` |
| GET | `relations/:scope` | Every judgment made on writes: relation, confidence, judge, and what Trust did |
| POST | `judge` | Judge `{ newer, older[] }` without storing anything (used by `eval/`) |
| GET | `graph` | Everything, for the demo's graph view |

## The judge

On every write, the Scope finds up to five similar memories of the same kind and asks the judge how the new one relates to each: `duplicate`, `refines`, `supersedes`, `contradicts` or `unrelated`. All candidates go in one System One request.

| Relation | What Trust does |
| --- | --- |
| duplicate (≥ 0.75) | No new entry. The write's origin and sources are added to the existing memory as a corroboration, the version bumps, and the memory is re-signed |
| contradicts (≥ 0.5, other session) | Both memories become `contested` and a conflict opens for review |
| supersedes (≥ 0.5) | The older memory becomes `superseded` and ranks last in recall. A write with lower trust than the memory it would replace opens a review instead |
| refines, unrelated | Logged only |

Every judgment is stored with the judge's name, its confidence, and the action taken (`relations/:scope`).

Pick the judge with `TRUST_JUDGE`:

| Setting | Judge |
| --- | --- |
| `auto` (default) | Clef-Flash through the Workers AI binding if present; else `TRUST_JUDGE_URL` if set; else the heuristic |
| `workers-ai` | `TRUST_JUDGE_MODEL`, default `@cf/cloudflare/clef-flash`; use `@cf/cloudflare/clef` for the larger model |
| `systemone` | Any `/v1/systemone` endpoint at `TRUST_JUDGE_URL`: a local Kev on Ollama or llama.cpp, hosted Jev, OpenRouter, LiteLLM. Model name in `TRUST_JUDGE_MODEL`; key, if needed, via `wrangler secret put TRUST_JUDGE_KEY` |
| `heuristic` | Word overlap, negation, figures and change words. No network |

A model call that fails or takes longer than `TRUST_JUDGE_TIMEOUT_MS` (1,500 ms for Workers AI, 5,000 ms for a URL) falls back to the heuristic, and the judgment records why. A slow model never blocks a write. With Jev, memory text leaves Cloudflare; with Clef on Workers AI or a local Kev, it doesn't.

`eval/` has 100 hand-labeled pairs and 12 scenario tasks for comparing judges. So far: a perfect (oracle) judge passes everything, and the heuristic scores 58% on pairs and passes 8 of 12 tasks. Model runs are next.

## MCP

Agents connect to `/mcp/:demo/:session` (MCP over streamable HTTP, JSON responses). Tools: `memory_recall`, `memory_remember`, `memory_retract`, `memory_why`, `memory_impact`. Calls go through the same authorization as the HTTP API, so an agent can't reach another matter over MCP either. In the demo the session in the URL is the identity; production needs a bearer token per agent.

## Guarantees the tests check (`npm test`, 27 checks)

- Origin comes from the session; entries without sources are capped at `unverified`.
- No cross-matter reads or writes, over HTTP or MCP, and refusals leak nothing.
- Why and impact chains; impact only counts changes merged after the recall.
- Remove-by-source and session rollback quarantine transitively.
- Promotion strips client names and figures and needs review before anything crosses.
- Secrets are rejected; every memory is signed and re-signed on re-verification.
- Contradicting memories from different sessions are marked contested until resolved.
- A changed source flags what it taught as stale, transitively.
- Walls pause live sessions on their next call.
- A duplicate write becomes corroboration (origin and sources kept, entry re-signed); a write that adds a figure is never merged.
- A sourced change supersedes the old memory and recall ranks the new one first; an unsourced write can't retire a sourced memory.
- Every judgment is logged with the judge that made it.

## Demo limits

This is a demo build. The API has no authentication, and the page acts as an administrator so visitors can try every operation. Each visit gets its own scopes, which delete themselves after an hour, with an operation cap per demo. A production build needs real identity on every call, admin-only rollback, remove-source and walls, and the git export described in the design doc.

MIT licensed.
