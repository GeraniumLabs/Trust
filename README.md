# Trust

Agent memory that knows where every memory came from.

Every memory Trust stores records its **origin** (which agent, session and step produced it, and who supervised) and its **sources** (the files, logs, documents or other memories it was drawn from, with content hashes). That makes memory explainable, scoped and reversible:

- **Why** does the agent believe this? Walk back to its sources.
- **What did it affect?** Recall receipts trace it forward to sessions and merged changes.
- **A source was wrong?** Remove it, and everything it taught, plus everything built on that, is quarantined.
- **Separate matters stay separate.** Each scope has its own store, every read is checked against walls on every call, and knowledge crosses only through a reviewed, de-identified promotion.

This repo is Trust v1 plus a public demo page, on Cloudflare Workers and Durable Objects (SQLite).

## Run it

```sh
npm install
npm run dev          # http://localhost:8787
npm test             # end-to-end checks against the dev server (BASE_URL to override)
npm run deploy       # your own workers.dev URL, shareable as-is
```

## Architecture

| Part | Role |
| --- | --- |
| Worker (`src/index.ts`) | API router, serves the demo page from `public/` |
| Registry DO (`src/registry.ts`) | One per demo: scopes, sessions, walls, merged changes, audit trail. Authorizes every read and write |
| Scope DO (`src/scope.ts`) | One per scope: SQLite tables for entries, append-only versions, sources, derivation links, recall receipts, promotion reviews |

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
| GET | `graph` | Everything, for the demo's graph view |

## MCP

Agents connect to `/mcp/:demo/:session` (MCP over streamable HTTP, JSON responses). Tools: `memory_recall`, `memory_remember`, `memory_retract`, `memory_why`, `memory_impact`. Calls go through the same authorization as the HTTP API, so an agent can't reach another matter over MCP either. In the demo the session in the URL is the identity; production needs a bearer token per agent.

## Guarantees the tests check (`npm test`, 21 checks)

- Origin comes from the session; entries without sources are capped at `unverified`.
- No cross-matter reads or writes, over HTTP or MCP, and refusals leak nothing.
- Why and impact chains; impact only counts changes merged after the recall.
- Remove-by-source and session rollback quarantine transitively.
- Promotion strips client names and figures and needs review before anything crosses.
- Secrets are rejected; every memory is signed and re-signed on re-verification.
- Contradicting memories from different sessions are marked contested until resolved.
- A changed source flags what it taught as stale, transitively.
- Walls pause live sessions on their next call.

Conflict detection is a heuristic (wording overlap plus opposite instructions). It is a placeholder for a model-based check; the contested status and review flow stay the same.

## Demo limits

This is a demo build. The API has no authentication, and the page acts as an administrator so visitors can try every operation. Each visit gets its own scopes, which delete themselves after an hour, with an operation cap per demo. A production build needs real identity on every call, admin-only rollback, remove-source and walls, and the git export described in the design doc.

MIT licensed.
