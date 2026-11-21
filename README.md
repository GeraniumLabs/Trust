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

## Identity

Every call carries a bearer token, and the token alone decides who is calling.

- **Admin token.** Returned once, when a space is created (`POST /api/demo`). It belongs to the person or service running the space: starting agent sessions, rollback, remove-by-source, walls, reviews, conflict resolution, the graph and exports. Set `TRUST_BOOTSTRAP_TOKEN` (`wrangler secret put`) and only its holder can create spaces; unset, anyone can, as on the public demo.
- **Agent tokens.** Returned once, when the admin starts a session (`POST sessions`). The session fixes the agent's name, supervisor and scope, and every memory it writes carries them, so an agent can't claim to be someone else. Agents can remember, recall, relate and retract, and read provenance in their own scope (plus advisory precedent). Tokens expire after 12 hours.
- **Revocation.** `POST sessions/:id/end` (the admin, or the session itself) ends a session and revokes its token. A wall pauses the supervisor's sessions on their next call.
- **Storage.** Only a SHA-256 hash of each token is stored, so a copy of the database can't be replayed as credentials. Tokens are prefixed `trust_adm_` / `trust_agt_` so secret scanners can spot them.

A session id in a request body is accepted only as a cross-check: if it doesn't match the token, the call is refused.

## Spaces

A space is one Registry Durable Object (sessions, tokens, walls, audit) plus one Scope Durable Object per scope (memories, sources, receipts, judgments), each with its own SQLite store. There are two kinds:

- **Demo spaces** (`POST /api/demo`): the Northwind, Contoso and precedent scopes, deleted after an hour, with an operation cap.
- **Persistent spaces** (`POST /api/spaces`, bootstrap token required): your own scopes, kept until an admin deletes the space. Scope kinds are `project` (a codebase, say), `matter` (client work, with names stripped on promotion) and `precedent` (at most one; reviewed, de-identified knowledge every scope can read as advisory).

```sh
curl -X POST https://trust.example/api/spaces -H "authorization: Bearer $TRUST_BOOTSTRAP_TOKEN" \
  -d '{"name":"Mergery","scopes":[{"id":"mergery","label":"mergery.dev repo","kind":"project"}]}'
# -> { "space": "a1b2c3d4e5f6", "adminToken": "trust_adm_...", ... }
```

Every route below works on both, as `/api/demo/:id/...` or `/api/spaces/:id/...`.

## API (per space)

**Who** is the token the call needs: admin, agent, or either (an agent only within its own scope).

| Method | Path | Who | Does |
| --- | --- | --- | --- |
| POST | `/api/demo` | bootstrap, if set | Create a space (expires after an hour on the demo). Returns the admin token |
| POST | `/api/spaces` | bootstrap | Create a persistent space with its own scopes. Returns the admin token |
| GET / DELETE | `/api/spaces/:id` | admin | The space and its scopes; or delete it and all its memory (`?confirm=<id>`) |
| GET / POST | `scopes` | admin | List scopes, or add one `{ id, label, kind, client? }` |
| POST | `sessions` | admin | Start an agent session bound to one scope. Returns the agent token |
| POST | `sessions/:id/end` | admin or that agent | End a session and revoke its token |
| POST | `remember` | agent | Write a memory with sources and parents |
| POST | `recall` | agent | Search the session's scope, plus advisory precedent. Writes recall receipts |
| GET | `why/:scope/:id` | either | Chain back through parents to sources |
| GET | `impact/:scope/:id` | either | Derived memories, recalling sessions, changes merged after the recall |
| GET | `history/:scope/:id` | either | Every version of a memory |
| POST | `remove-source` | admin | Quarantine everything a source taught, transitively |
| POST | `rollback` | admin | Quarantine everything a session wrote |
| POST | `promote` | admin | De-identify a memory and open a review |
| POST | `reviews/:id` | admin | Approve or reject a promotion |
| POST | `walls` | admin | Wall a supervisor off a scope. Pauses their live sessions |
| POST | `changes` | admin | Record a merged change for a session |
| POST | `retract` | agent | Retract a memory with a reason (stays in history) |
| POST | `source-changed` | admin | A cited source moved to a new version: flag what it taught as stale, transitively |
| POST | `reverify` | admin | Clear a stale flag after checking the memory against the new source version |
| GET / POST | `conflicts/:scope` / `conflicts/:id` | admin | List conflicts, or resolve one: `keep_a`, `keep_b`, `keep_both`, `retract_both` |
| GET | `verify/:scope/:id` | either | Check a memory's signature over its origin and source versions |
| GET | `export/:scope` | admin | The scope as an OKF-style bundle: one Markdown file per memory, plus `log.md` and `index.md` |
| POST | `relate` | agent | The agent's decision on two memories: `{ session, scope, entry, other, relation, note }` |
| GET | `judge-config` | admin | The judge in use and the bars it must clear |
| GET | `relations/:scope` | admin | Every judgment made on writes: relation, confidence, judge, and what Trust did |
| POST | `judge` | admin | Judge `{ newer, older[] }` without storing anything (used by `eval/`) |
| GET | `graph` | admin | Everything, for the demo's graph view |

## The judge

On every write, the Scope finds up to five similar memories of the same kind and asks the judge how the new one relates to each: `duplicate`, `refines`, `supersedes`, `contradicts` or `unrelated`. All candidates go in one System One request.

| Relation | What Trust does |
| --- | --- |
| duplicate | No new entry. The write's origin and sources are added to the existing memory as a corroboration, the version bumps, and the memory is re-signed |
| contradicts (other session) | Both memories become `contested` and a conflict opens for review |
| supersedes | The older memory becomes `superseded` and ranks last in recall. A write with lower trust than the memory it would replace opens a review instead |
| refines, unrelated | Logged only |

A judgment acts only when its confidence clears the bar for its relation. Each model has its own bars, set from its eval run, because models report confidence very differently: Jev acts at duplicate 0.75, supersedes 0.7, contradicts 0.5; Clef-Flash at 0.45, 0.45 and 0.2. Unscored models get Jev's bars. The heuristic merges only identical text. Override with `TRUST_JUDGE_THRESHOLDS`, flat or per judge (see `eval/README.md`); `GET judge-config` shows what's in force. Every judgment is stored with the judge's name, its confidence, and the action taken (`relations/:scope`).

Pick the judge with `TRUST_JUDGE`:

| Setting | Judge |
| --- | --- |
| `auto` (default) | Clef-Flash through the Workers AI binding if present; else `TRUST_JUDGE_URL` if set; else the heuristic |
| `workers-ai` | `TRUST_JUDGE_MODEL`, default `@cf/cloudflare/clef-flash`; use `@cf/cloudflare/clef` for the larger model |
| `systemone` | Any `/v1/systemone` endpoint at `TRUST_JUDGE_URL`: a local Kev on Ollama or llama.cpp, hosted Jev, OpenRouter, LiteLLM. Model name in `TRUST_JUDGE_MODEL`; key, if needed, via `wrangler secret put TRUST_JUDGE_KEY` |
| `heuristic` | Word overlap, negation, figures and change words. No network |

**Unsure judgments go to the agent.** A judgment under the model's unsure cutoff (0.55 for Jev, 0.25 for Clef-Flash; `TRUST_JUDGE_UNSURE_BELOW` overrides), or one that would act but doesn't clear its bar, changes nothing. Instead, `memory_remember` returns an `unsure` note naming the other memory and the judge's reading. If a second model is configured (`TRUST_JUDGE_SECOND`, `TRUST_JUDGE_SECOND_MODEL`, and `TRUST_JUDGE_SECOND_URL`/`_KEY` for an endpoint), its reading is included too. The second opinion never acts on its own, because it can be as confidently wrong as the first. The agent checks the evidence and records its decision with `memory_relate`, which applies the same rules as a confident judge. Open notes show on the memory for every agent that recalls it until someone decides. On the eval runs, Jev sent 8 of 160 writes back to the agent and Clef-Flash 19; between them those notes covered every miss that mattered but two.

A model call that fails or takes longer than `TRUST_JUDGE_TIMEOUT_MS` (1,500 ms for Workers AI, 5,000 ms for a URL) falls back to the heuristic, and the judgment records why. A slow model never blocks a write. With Jev, memory text leaves Cloudflare; with Clef on Workers AI or a local Kev, it doesn't.

`eval/` has 160 hand-labeled pairs (a core set and a hard set) and 12 scenario tasks for comparing judges and setting bars. So far: Jev, Clef and Clef-Flash all pick the right relation 90-98% of the time; with their own bars none made a wrong merge, retirement or conflict. Recommended setup: Clef-Flash as the judge, Jev as the second opinion.

## MCP

Agents connect to `/mcp/:space` (MCP over streamable HTTP, JSON responses) with their session token as `Authorization: Bearer trust_agt_...`. Tools: `memory_recall`, `memory_remember`, `memory_relate`, `memory_retract`, `memory_why`, `memory_impact`. Calls go through the same HTTP API with the same token, so an agent can't reach another matter over MCP either. The old `/mcp/:demo/:session` form is refused, as is the admin token.

## Guarantees the tests check (`npm test`, 41 checks)

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
- An unsure judgment takes no action and returns a note to the agent; the agent's `relate` decision is applied with the same rules and closes the note.
- No token, a made-up token, another space's token, or an agent token claiming a different session is refused; agents can't start sessions, roll back, wall, or see the graph; an agent can't read another matter's provenance.
- Ending a session revokes its token over HTTP and MCP; tokens never appear in any response after issue.
- Persistent spaces need the bootstrap token, get their own scope ids and entry prefixes, work without a precedent scope, and are deleted only by their admin with confirmation.

## Demo limits

The public demo lets anyone create a space, and the page holds that space's admin token and its agents' tokens (in memory only) so visitors can try every operation. Each space deletes itself after an hour, with an operation cap. Still to do for production: more than one admin per space, token rotation, and the git export described in the design doc.

MIT licensed.
