import { AigwClient } from './aigw';
import { search as runSearch, configuredProviders } from './search/registry';
import { runResearch, type ResearchDeps } from './research';
import { getJob, listJobs, saveRun } from './db';

/**
 * deepscout — a research orchestrator over ai-gw. It searches, fetches (via
 * ai-gw /v1/fetch), extracts (ai-gw route:reasoning) and synthesizes (Gemini),
 * recording a full step trail to D1. A run is bounded so it fits the Cloudflare
 * free tier in a single request; deep multi-round work can later move to a
 * Cloudflare Workflow (see README).
 *
 * Routes:
 *   GET  /                → status + configured search providers
 *   POST /research        → { question, maxRounds?, urlsPerRound? } → run + store
 *   GET  /research        → recent jobs
 *   GET  /research/:id    → one job + its full step trail
 */

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});
}

/** Bearer gate — only enforced when DEEPSCOUT_TOKEN is set. */
function authed(request: Request, env: Env): boolean {
	if (!env.DEEPSCOUT_TOKEN) return true;
	const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
	return m?.[1]?.trim() === env.DEEPSCOUT_TOKEN;
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

		if (!authed(request, env)) {
			return json({ error: 'unauthorized' }, 401);
		}
		if (!env.DB) return json({ error: 'no DB binding' }, 500);
		if (!env.AIGW_API_KEY) return json({ error: 'AIGW_API_KEY not configured' }, 500);

		// GET /research  (list)  |  GET /research/:id  (one)
		if (request.method === 'GET' && path.startsWith('/research')) {
			const id = path.slice('/research/'.length);
			if (path === '/research') return json({ jobs: await listJobs(env.DB) });
			const found = await getJob(env.DB, id);
			return found ? json(found) : json({ error: 'not found' }, 404);
		}

		// POST /research  (run)
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
			if (!configuredProviders(env).length) {
				return json(
					{ error: 'no search provider configured (set TAVILY_API_KEY or BRAVE_API_KEY)' },
					500
				);
			}

			const aigw = new AigwClient(env.AIGW_BASE_URL, env.AIGW_API_KEY);
			const deps: ResearchDeps = {
				search: (q, n) => runSearch(env, q, n),
				fetchUrls: (urls) => aigw.fetchUrls(urls),
				infer: (opts) => aigw.run(opts),
				now: () => Date.now(),
				uuid: () => crypto.randomUUID()
			};

			const id = crypto.randomUUID();
			const nowSec = Math.floor(Date.now() / 1000);
			try {
				const outcome = await runResearch(deps, {
					question,
					maxRounds: body.maxRounds,
					urlsPerRound: body.urlsPerRound,
					extractBatch: body.extractBatch
				});
				const status = outcome.report ? 'ok' : 'error';
				await saveRun(
					env.DB,
					id,
					outcome,
					status,
					outcome.report ? null : 'no report produced',
					nowSec
				);
				return json({
					id,
					status,
					report: outcome.report,
					sources: outcome.sources,
					modelsUsed: outcome.modelsUsed,
					searchProviders: outcome.searchProviders,
					rounds: outcome.rounds,
					costUsd: outcome.costUsd,
					ms: outcome.ms,
					steps: outcome.steps.length
				});
			} catch (e) {
				const msg = String(e).slice(0, 500);
				await saveRun(
					env.DB,
					id,
					{
						question,
						report: '',
						notes: [],
						sources: [],
						steps: [],
						modelsUsed: [],
						searchProviders: [],
						rounds: 0,
						costUsd: 0,
						ms: 0
					},
					'error',
					msg,
					nowSec
				).catch(() => {});
				return json({ id, error: msg }, 500);
			}
		}

		return json({ error: 'not found' }, 404);
	}
} satisfies ExportedHandler<Env>;
