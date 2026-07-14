import { configuredProviders } from './search/registry';
import { enqueue, getJob, listJobs } from './db';

// The Durable Object queue engine must be exported from the Worker's main module.
export { ResearchQueue } from './queue';

/**
 * deepscout — a queued research orchestrator over ai-gw.
 *
 *   POST /research           → enqueue { question, maxRounds?, urlsPerRound? } → 202 { id, status:'queued' }
 *   GET  /research/:id        → job status + report (when done) + full step trail
 *   GET  /research/:id?download=1 → same, as a downloadable JSON archive
 *   GET  /research            → recent jobs / queue
 *   POST /drain               → process one now (manual nudge; same work the DO alarm does)
 *   GET  /                    → status + configured search providers
 *
 * The queue is a Durable Object (src/queue.ts): enqueue kicks it, it drains one
 * job at a time and goes dormant when empty (no cron, no idle polling). Failed
 * runs back off + retry, rotating the search provider.
 */

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
	});
}

function authed(request: Request, env: Env): boolean {
	if (!env.DEEPSCOUT_TOKEN) return true;
	const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
	return m?.[1]?.trim() === env.DEEPSCOUT_TOKEN;
}

function queue(env: Env) {
	return env.RESEARCH_QUEUE.get(env.RESEARCH_QUEUE.idFromName('singleton'));
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

		// Enqueue a research request → kick the queue → return the id to poll.
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
			await queue(env).kick();
			return json({ id, status: 'queued', poll: `/research/${id}` }, 202);
		}

		// Manual nudge — do one unit of the queue's work now.
		if (request.method === 'POST' && path === '/drain') {
			return json({ handled: await queue(env).drainNow() });
		}

		if (request.method === 'GET' && path.startsWith('/research')) {
			if (path === '/research') return json({ jobs: await listJobs(env.DB) });
			const id = path.slice('/research/'.length);
			const found = await getJob(env.DB, id);
			if (!found) return json({ error: 'not found' }, 404);
			// ?download=1 → self-contained JSON archive (so ai-gw R2 payloads for
			// this run's inference calls become disposable).
			if (url.searchParams.get('download')) {
				return json(found, 200, {
					'content-disposition': `attachment; filename="research-${id}.json"`
				});
			}
			return json(found);
		}

		return json({ error: 'not found' }, 404);
	}
} satisfies ExportedHandler<Env>;
