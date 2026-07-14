# CLAUDE.md — deepscout

Guidance for AI agents working in this repo. Keep it current when conventions change.

## What this is

**deepscout** is a **research orchestrator** — a Cloudflare Worker that turns a question into a
cited report by fanning out over free web-search + free LLMs. It does **no inference or
page-fetching itself**: it calls **ai-gw** (the sibling AI-inference gateway at
`C:\New folder\ai-gw`, live at `https://ai-gw.jens-naterman-e05.workers.dev`) for both. deepscout
owns only the research loop and the debug trail.

Pipeline per round (`src/research.ts`):

1. **search** — one query per configured provider (fall-through), collect candidate URLs.
2. **blacklist dedup** — drop URLs already seen this run (the "not-covered-twice" set).
3. **fetch** — page text for results without content, via ai-gw `POST /v1/fetch` (batched, ≤10
   URLs/call). Tavily already returns content, so those skip the fetch.
4. **fan-out extract** — partition the fresh docs into **disjoint** batches, one `POST /v1/run
   {route:"reasoning"}` per batch. Disjoint = each model covers a distinct URL set, never
   overlapping (this is the user's "blacklist of URLs other models already handle").
5. **gap check** — ask a model what's still missing → follow-up queries for the next round.
6. **synthesize** — one `POST /v1/run` on Gemini (huge context) → cited markdown report.

## Core design decisions (locked)

- **Thin orchestrator over ai-gw.** All keys, provider fall-through, cost metering and inference
  logging live in ai-gw. deepscout calls `/v1/fetch` (page text) and `/v1/run` (route:reasoning
  for extract, Gemini for synth). It never holds provider keys — only an ai-gw project key.
- **Free-tier bounded.** The Cloudflare **Workers free tier caps a request at 50 subrequests**.
  A run uses ~1 search + 1 batched fetch + a few extract calls + 1 gap + 1 synth per round —
  well under 50 even at 2–3 rounds. Fetch is batched (≤10 URLs = 1 subrequest). Runs are
  **synchronous** (one request returns the report). Bounds: `maxRounds ≤ 4`, `urlsPerRound ≤ 12`.
- **D1 debug trail (free-tier sized).** Every run writes one `research_job` row + one
  `research_step` row per pipeline step (~10–20 rows/run) recording phase, search provider, the
  **winning LLM model** (from ai-gw's trace), cost and timing. D1 free = 100k writes/day → ample.
  Large payloads are clipped to 6 KB so a step row can't blow D1's value-size limit. Full raw
  page text is NOT stored (heavy) — sources + notes + the model trace are enough to debug/re-run.
- **Search providers: pluggable, skip-if-no-key.** `src/search/registry.ts` fall-through, content
  providers first (Tavily → fewer fetches), then link-only (Brave). Adding one = an adapter +
  one line + its key. More free-tier providers land here from the search-provider research.
- **Dependency-injected core.** `runResearch(deps, opts)` takes `{search, fetchUrls, infer, …}`
  so it's unit-testable with fakes (`test/research.test.ts`, run via `node --test`). The Worker
  (`src/index.ts`) wires the real deps (ai-gw client + search registry).

## Stack

Plain Cloudflare Worker (TypeScript, no framework — it's a job backend, not a UI). D1 for the
debug trail. `wrangler`. No SvelteKit (unlike ai-gw/siblings) because a Workflow-ready backend
is cleaner as a raw Worker. Prettier: tabs, single quotes, no trailing comma, width 100.

## Commands

```bash
npm run dev                 # wrangler dev (local miniflare D1)
npm run check               # wrangler types + tsc --noEmit
npm run lint                # prettier + eslint
npm run test                # node --test (type-strips the .ts; no build)
npm run db:migrate:local / :remote
npm run deploy              # wrangler deploy
```

## API

| Method · Path        | Does                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| `GET /`              | status + configured search providers (public)                               |
| `POST /research`     | `{ question, maxRounds?, urlsPerRound?, extractBatch? }` → run + store + report |
| `GET /research`      | recent jobs (metadata)                                                      |
| `GET /research/:id`  | one job + its full step trail (the debug view)                              |

Auth: if `DEEPSCOUT_TOKEN` is set, all but `GET /` require `Authorization: Bearer <token>`.

## Bindings & env

- Binding: `DB` (D1 `deepscout-db`).
- Var: `AIGW_BASE_URL` (ai-gw gateway URL).
- Secrets (`wrangler secret put` / `.dev.vars`): `AIGW_API_KEY` (an ai-gw project key for
  project "deepscout"), `TAVILY_API_KEY`, `BRAVE_API_KEY` (+ more search providers), optional
  `DEEPSCOUT_TOKEN`. Absent search key = that provider is skipped; ≥1 required to run.

## Deploy (owner, one-time)

Mirrors ai-gw's model — **Cloudflare pulls and builds from Git**; no GitHub Actions.

1. `wrangler d1 create deepscout-db` → paste the id into `wrangler.jsonc`.
2. `npm run db:migrate:remote`.
3. Mint an ai-gw project key for "deepscout" (ai-gw `/keys`), set `AIGW_API_KEY`. Get free
   Tavily + Brave keys, set them. Optionally set `DEEPSCOUT_TOKEN`. All via `wrangler secret put`.
4. Create the GitHub repo (SSH as the `murmelad` account, like ai-gw) + connect it in the
   Cloudflare dashboard (Workers Builds), or `npm run deploy` manually.

## Scaling path (when a run needs to outgrow one request)

Multi-round deep research that exceeds the 50-subrequest / single-request budget should move to
a **Cloudflare Workflow** (durable, per-step retries, each step its own subrequest budget) or a
Durable Object driven by alarms — both on the free tier. Keep `runResearch`'s pure core; wrap it
so each `phase` becomes a Workflow `step.do(...)`. Queues are **paid-only** — don't use them.

## Conventions & gotchas

- The core is pure + injected — add pipeline logic there and cover it in `test/research.test.ts`.
- `node --test` runs the `.ts` directly (Node ≥23 strips types); `import type` keeps the test
  free of runtime deps. tsc typechecks `src` only (Workers types); tests aren't in the tsc program.
- Search/LLM keys copied from elsewhere often carry quotes/CRLF — strip before `wrangler secret
  put` (bit us repeatedly in ai-gw).
- Commit as **murmelad** (personal GitHub), never the work identity.
