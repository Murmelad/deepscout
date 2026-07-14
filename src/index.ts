import { AigwClient } from './aigw';
import { search as runSearch, configuredProviders } from './search/registry';
import { runResearch, type ResearchDeps } from './research';
import { claimNext, complete, enqueue, failOrRetry, getJob, listJobs, reclaimStale } from './db';

/**
 * deepscout — a queued research orchestrator over ai-gw.
 *
 *   POST /research        → enqueue { question, maxRounds?, urlsPerRound? }; returns { id, status:'queued' }
 *   GET  /research/:id    → job status + report (when done) + full step trail
 *   GET  /research        → recent jobs / queue
 *   POST /drain           → process the queue now (manual nudge; same work the cron does)
 *   GET  /                → status + configured search providers
 *
 * A Cron Trigger (every minute) drains the D1-backed queue in order — Cloudflare
 * Queues are paid-only, so the queue is a table + cron. A failed run backs off
 * and retries (up to 3), each retry rotating which search provider leads, so a
 * rate-limited provider is skipped next time.
 */

const MAX_PER_TICK = 3; // jobs processed per cron tick (keeps under free-tier limits)

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});
}

function authed(request: Request, env: Env): boolean {
	if (!env.DEEPSCOUT_TOKEN) return true;
	const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
	return m?.[1]?.trim() === env.DEEPSCOUT_TOKEN;
}

/** Deps for a run; `attempt` rotates the search provider that leads. */
function buildDeps(env: Env, attempt: number): ResearchDeps {
	const aigw = new AigwClient(env.AIGW_BASE_URL, env.AIGW_API_KEY);
	return {
		search: (q, n) => runSearch(env, q, n, attempt),
		fetchUrls: (urls) => aigw.fetchUrls(urls),
		infer: (opts) => aigw.run(opts),
		now: () => Date.now(),
		uuid: () => crypto.randomUUID()
	};
}

/** Claim and process one queued job. Returns the job id handled, or null. */
async function processOne(env: Env): Promise<{ id: string; status: string } | null> {
	const nowSec = Math.floor(Date.now() / 1000);
	await reclaimStale(env.DB, nowSec);
	const job = await claimNext(env.DB, nowSec);
	if (!job) return null;

	try {
		const outcome = await runResearch(buildDeps(env, job.attempts), {
			question: job.question,
			maxRounds: job.opts.maxRounds,
			urlsPerRound: job.opts.urlsPerRound,
			extractBatch: job.opts.extractBatch
		});
		if (outcome.report) {
			await complete(env.DB, job.id, outcome, Math.floor(Date.now() / 1000));
			return { id: job.id, status: 'ok' };
		}
		const status = await failOrRetry(
			env.DB,
			job.id,
			job.attempts,
			'no report produced (extraction/synthesis yielded nothing)',
			Math.floor(Date.now() / 1000),
			outcome
		);
		return { id: job.id, status };
	} catch (e) {
		const status = await failOrRetry(
			env.DB,
			job.id,
			job.attempts,
			String(e),
			Math.floor(Date.now() / 1000),
			null
		);
		return { id: job.id, status };
	}
}

/** Drain up to `max` jobs (one at a time, in order). */
async function processQueue(
	env: Env,
	max = MAX_PER_TICK
): Promise<{ id: string; status: string }[]> {
	const handled: { id: string; status: string }[] = [];
	for (let i = 0; i < max; i++) {
		const r = await processOne(env);
		if (!r) break;
		handled.push(r);
	}
	return handled;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, '') || '/';

		if (path === '/') {
			return json({
				service: 'deepscout',
				ok: true,
				searchProviders: configuredProviders(env).map((p) => p.id),
				aigw: env.AIGW_BASE_URL
			});
		}

		if (!authed(request, env)) return json({ error: 'unauthorized' }, 401);
		if (!env.DB) return json({ error: 'no DB binding' }, 500);

		// Enqueue a research request.
		if (request.method === 'POST' && path === '/research') {
			let body: {
				question?: string;
				maxRounds?: number;
				urlsPerRound?: number;
				extractBatch?: number;
			};
			try {
				body = (await request.json()) as typeof body;
			} catch {
				return json({ error: 'invalid JSON body' }, 400);
			}
			const question = String(body.question ?? '').trim();
			if (!question) return json({ error: '`question` is required' }, 400);
			if (!env.AIGW_API_KEY) return json({ error: 'AIGW_API_KEY not configured' }, 500);
			if (!configuredProviders(env).length) {
				return json(
					{ error: 'no search provider configured (set EXA_API_KEY / TAVILY_API_KEY / …)' },
					500
				);
			}
			const id = crypto.randomUUID();
			await enqueue(
				env.DB,
				id,
				question,
				{
					maxRounds: body.maxRounds,
					urlsPerRound: body.urlsPerRound,
					extractBatch: body.extractBatch
				},
				Math.floor(Date.now() / 1000)
			);
			return json({ id, status: 'queued', poll: `/research/${id}` }, 202);
		}

		// Manual nudge — do the cron's work now (handy without waiting a minute).
		if (request.method === 'POST' && path === '/drain') {
			const handled = await processQueue(env);
			return json({ handled });
		}

		if (request.method === 'GET' && path.startsWith('/research')) {
			if (path === '/research') return json({ jobs: await listJobs(env.DB) });
			const id = path.slice('/research/'.length);
			const found = await getJob(env.DB, id);
			return found ? json(found) : json({ error: 'not found' }, 404);
		}

		return json({ error: 'not found' }, 404);
	},

	// Cron Trigger (every minute) drains the queue.
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(processQueue(env));
	}
} satisfies ExportedHandler<Env>;
