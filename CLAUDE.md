# CLAUDE.md — deepscout

Guidance for AI agents working in this repo. Keep it current when conventions change.

## What this is

**deepscout** is a **research orchestrator** — a Cloudflare Worker that turns a question into a
cited report by fanning out over free web-search + free LLMs. It does **no inference or
page-fetching itself**: it calls **ai-gw** (the sibling AI-inference gateway at
`C:\New folder\ai-gw`, live at `https://ai-gw.jens-naterman-e05.workers.dev`) for both. deepscout
owns only the research loop and the debug trail.

Pipeline (`src/research.ts`):

0. **plan** (once, before round 0) — decompose the QUESTION into 3–5 focused, keyword-style
   search queries covering its distinct facets/entities. A raw question is a poor search query
   and a single query pulls only ~`maxResultsPerQuery` candidates; planning sharpens the wording
   and fans out, so round 0 gathers far more on-target URLs. Falls back to the raw question if
   planning fails/returns nothing. One high-leverage call → the strong, Gemini-first
   **`reasoning`** route (`research-plan` use-case).

Then per round:

1. **search** — one query per configured provider (fall-through), collect candidate URLs.
2. **blacklist dedup** — drop URLs already seen this run (the "not-covered-twice" set).
3. **fetch** — page text for results without content, via ai-gw `POST /v1/fetch` (batched, ≤10
   URLs/call). Tavily already returns content, so those skip the fetch.
4. **fan-out extract** — partition the fresh docs into **disjoint** batches, one `POST /v1/run
{route:"research-extract"}` per batch. Disjoint = each model covers a distinct URL set, never
   overlapping (this is the user's "blacklist of URLs other models already handle").
5. **gap check** — ask a model what's still missing → follow-up queries for the next round
   (also the Gemini-free **`research-extract`** route).
6. **synthesize** — one `POST /v1/run {route:"research-synth"}` (Gemini first for its huge
   context, deep non-Gemini fallback) → cited markdown report.

**Model allocation (why three routes).** The bulk work — extract batches + the per-round gap
check — runs on **`research-extract`**, a deliberately **Gemini-free** chain, so a large run
doesn't exhaust Gemini's free tier on the cheap tasks. Gemini is reserved for the two
high-value calls: **plan** (once, steers everything → `reasoning`) and **synthesis** (final
report → `research-synth`, Gemini-first with a non-Gemini fallback so a rate-limit still yields
a report). All three routes live in ai-gw and are retunable there with no deepscout redeploy.

**Resume, don't restart.** deepscout persists the gathered notes+sources right before
synthesis (`saveNotes`). If a run fails only at synthesis (e.g. a transient rate-limit), the
retry passes those notes back as `runResearch`'s `resume` option and jumps straight to
synthesis — no re-searching/-extracting, and no re-hitting the limits that caused the failure.

## Core design decisions (locked)

- **Thin orchestrator over ai-gw.** All keys, provider fall-through, cost metering and inference
  logging live in ai-gw. deepscout calls `/v1/fetch` (page text) and `/v1/run` (routes `reasoning`
  for plan, `research-extract` for extract/gap, `research-synth` for synthesis — see Model
  allocation above). It never holds provider keys — only an ai-gw project key.
- **Queued via a Durable Object — event-driven, dormant when empty (`src/queue.ts`).** The queue
  engine is one SQLite-backed DO (`idFromName('singleton')`, free-tier eligible). `POST /research`
  inserts a `queued` row and calls `kick()` → an alarm fires ~immediately. `alarm()` processes ONE
  job (in order), then `reschedule()` sets the next alarm to the earliest queued `next_run_at`
  (now if more are ready, the retry time for a backed-off job) — or **deletes the alarm and goes
  dormant** when the queue is empty. No cron, no idle polling; it wakes only for real work.
  `POST /drain` (`drainNow()`) processes one immediately for a manual nudge. Poll `GET /research/:id`.
- **Backoff + provider rotation on failure.** A failed/empty run is requeued with exponential
  backoff (`backoffSec`, capped 30 min) up to **5 attempts**, then `error`; the DO's alarm wakes
  at the retry time. Each retry passes the attempt count as a `rotate` offset to the search
  registry, so a rate-limited provider is _not_ tried first next time. (`db.ts` `failOrRetry`.)
  Retries are cheap because a synth-only failure **resumes** from saved notes (see "Resume, don't
  restart" above), so more attempts are affordable. Stale `running` claims (crash mid-run) are
  reaped on the next alarm/kick — and `nextWakeAt` counts a running claim's reap time
  (`running_at + STALE_SEC`), so `reschedule()` keeps an alarm set for it rather than going
  dormant: a crash with an otherwise-empty queue self-heals instead of stranding the job.
- **Free-tier bounded per run.** Workers free caps an invocation (incl. a DO alarm) at **50
  subrequests** and **10 ms CPU**. Subrequests: ~1 search + 1 batched fetch (≤10 URLs = 1) + a few
  extract + 1 gap + 1 synth per round — well under 50 even at 2–3 rounds (network waits aren't
  CPU). CPU: prompt-building/JSON is the only real cost; the DO processes ONE job per alarm to
  keep it minimal; a pathological job that brushes 10 ms gets killed, stays `running`, and is
  reaped→retried. Workers Paid ($5/mo, CPU 30 s) removes the concern. Bounds: `maxRounds ≤ 4`,
  `urlsPerRound ≤ 12`.
- **D1 debug trail (free-tier sized).** One `research_job` row (+ queue bookkeeping: attempts,
  next_run_at, running_at) + one `research_step` row per pipeline step (~10–20 rows/run) recording
  phase, search provider, the **winning LLM model** (from ai-gw's trace), cost and timing. The
  trail is **checkpointed live** (`saveProgress` after planning + each round, one atomic
  DELETE+INSERT batch so a poll never sees an empty trail) so a running job streams progress; it's
  rewritten each attempt. D1 free = 100k writes/day → ample (checkpoints are bounded: plan + one
  per round). Payloads clipped to 6 KB; full raw page text is NOT stored — sources + notes + the
  model trace are enough to debug/re-run.
- **Search providers: pluggable, skip-if-no-key.** `src/search/registry.ts` fall-through,
  content-returning first: **exa** (~20k req/mo, returns page text) → **tavily** (1k/mo, content
  via include_raw_content) → **serper** (2,500/mo, links only) → **brave** (now $5/mo
  auto-credits, links only). Adding one = an adapter + one line + its key.
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

| Method · Path                  | Does                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                        | status + configured search providers (public)                                                                               |
| `POST /research`               | enqueue `{ question, maxRounds?, urlsPerRound?, extractBatch?, maxResultsPerQuery? }` → `202 { id, status:'queued', poll }` |
| `GET /research/:id`            | job status (queued/running/ok/error) + report when done + full step trail                                                   |
| `GET /research/:id?download=1` | same, as a downloadable JSON archive (self-contained → ai-gw R2 payloads become disposable)                                 |
| `GET /research`                | recent jobs / queue (metadata)                                                                                              |
| `POST /drain`                  | process one job now (same work the DO alarm does; manual nudge / local dev)                                                 |

Auth: if `DEEPSCOUT_TOKEN` is set, all but `GET /` require `Authorization: Bearer <token>`.

## Preparing a good research request

deepscout's **internal** models are the free tier — extraction on the `reasoning` route
(DeepSeek / GLM / gpt-oss) and synthesis on Gemini Flash — and are much weaker than whatever
capable model is _calling_ deepscout. The extract/synth system prompts are fixed and generic, so
**the question is your only lever** — the caller should do the thinking the weak models can't and
hand over a request engineered to succeed:

- **One specific, answerable question.** Refine a vague ask into a single question with the
  constraints baked in — time horizon (“as of 2026”), region, and the exact comparison axes or
  deliverable. The weak models won't infer scope; state it explicitly.
- **Name the candidates/entities.** For a comparison or survey, list what to check in the
  question (“compare X, Y, Z on price, latency, and free tier”). This both steers the search
  queries and tells extraction what to look for. (This repo's own provider research did exactly
  that — it enumerated the providers to verify.)
- **Front-load the deliverable shape.** Spell out what to return per item (“for each: free-tier
  limit, whether a card is required, and any catch”). That's the only place “what good looks
  like” can enter, since the prompts are generic.
- **Decompose big topics into several focused jobs**, queued separately, not one mega-question.
  Each job stays within the free-tier per-run bounds, and a narrow scope is where the weak models
  perform best. Combine the reports yourself.
- **Tune the knobs to the topic:** `maxRounds` (≤4) higher for broad/exploratory topics (more
  gap-filling), 1–2 for narrow factual ones; `urlsPerRound` (≤12) for source breadth;
  `extractBatch` smaller = more parallel model calls (more independent rate-limit buckets),
  larger = fewer calls but more text per model.
- **Prefer web-answerable questions.** The first-pass fetch is lightweight HTML→text (no
  paywalls, no PDFs). With `render:true`, JS-thin/blocked pages are escalated to a real browser on
  a residential IP (the **homescout** service, via ai-gw `/v1/fetch {render:"residential"}`) —
  capped at `RENDER_CAP` per round, and only if homescout is configured in ai-gw (else those pages
  stay thin). Favor topics covered by public article/doc text.
- **Treat the report as sourced raw material, not the final word.** deepscout does breadth-first
  gathering + a Flash-tier synthesis. For anything reasoning-heavy, have the capable caller reason
  over the returned **notes + sources** (every claim carries its URL) rather than trusting the
  synthesized prose.

## Bindings & env

- Bindings: `DB` (D1 `deepscout-db`, id in `wrangler.jsonc`), `RESEARCH_QUEUE` (Durable Object
  `ResearchQueue`, SQLite migration tag `v1`).
- Var: `AIGW_BASE_URL` (ai-gw gateway URL).
- Secrets (`wrangler secret put` / `.dev.vars`): `AIGW_API_KEY` (an ai-gw project key for
  project "deepscout"), `EXA_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `BRAVE_API_KEY`,
  optional `DEEPSCOUT_TOKEN`. Absent search key = that provider is skipped; ≥1 required to run.

## Deploy (owner, one-time)

Mirrors ai-gw's model — **Cloudflare pulls and builds from Git**; no GitHub Actions.

1. `wrangler d1 create deepscout-db` → paste the id into `wrangler.jsonc`.
2. `npm run db:migrate:remote`.
3. Mint an ai-gw project key for "deepscout" (ai-gw `/keys`), set `AIGW_API_KEY`. Get free
   search keys (Exa is the most generous — ~20k/mo; + Tavily/Serper), set them. Optionally set
   `DEEPSCOUT_TOKEN`. All via `wrangler secret put`.
4. Create the GitHub repo (SSH as the `murmelad` account, like ai-gw) + connect it in the
   Cloudflare dashboard (Workers Builds), or `npm run deploy` manually. Cron triggers deploy
   with the Worker automatically (no extra step).

## Scaling path (when a single run needs to outgrow one request/alarm)

The DO alarm runs a whole job in one invocation (fine within 50 subrequests / 10 ms CPU for
bounded runs). If a single run must go deeper (more rounds/URLs than one invocation allows), split
`runResearch` so each `phase` is its own DO alarm hop (persist partial state in the DO's SQLite
between hops) or move to a **Cloudflare Workflow** (durable per-step retries) — both free-tier.
Keep the pure core. Cloudflare **Queues are paid-only** — the DO+alarm queue is the free path.

## Conventions & gotchas

- The core is pure + injected — add pipeline logic there and cover it in `test/research.test.ts`.
- `node --test` runs the `.ts` directly (Node ≥23 strips types); `import type` keeps the test
  free of runtime deps. tsc typechecks `src` only (Workers types); tests aren't in the tsc program.
- Search/LLM keys copied from elsewhere often carry quotes/CRLF — strip before `wrangler secret
put` (bit us repeatedly in ai-gw).
- Commit as **murmelad** (personal GitHub), never the work identity.
- **Workers-Builds secret gotcha (bit us twice):** on a Git-connected Worker, a secret set via
  `wrangler secret put` / dashboard updates the store but the **running (Builds) deployment
  doesn't bind it until the next deploy** — the code reads it as unset (e.g. `searchProviders:
[]`). After setting secrets, run one `WRANGLER_SEND_METRICS=false wrangler deploy` (or push a
  commit) to bind them. Secrets then persist across future Git builds.
