import type { SearchProvider, SearchResult } from './types';
import { bumpUsage } from '../db';
import { exa } from './exa';
import { tavily } from './tavily';
import { serper } from './serper';
import { brave } from './brave';

/**
 * Search providers in fall-through priority (verified free tiers, 2026-07):
 *   exa     — ~20k req/mo, returns page content (best; fewest fetches)
 *   tavily  — 1k credits/mo, returns content with include_raw_content
 *   serper  — 2,500 Google-SERP queries/mo, links + snippets only
 *   brave   — now $5/mo auto-credits (pay-per-request), links only
 * Add a provider = import + one line here + its key. Content providers first.
 */
const PROVIDERS: SearchProvider[] = [exa, tavily, serper, brave];

const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchOutcome {
	provider: string;
	results: SearchResult[];
}

/** Configured providers in priority order. */
export function configuredProviders(env: Env): SearchProvider[] {
	return PROVIDERS.filter((p) => p.configured(env));
}

/**
 * Run one query through the first configured provider that succeeds. `rotate`
 * offsets which provider is tried first (the queue passes the attempt count, so
 * a retried job leads with a *different* provider than the one that failed).
 * Returns the provider id used + results; throws only if every provider errors.
 */
export async function search(
	env: Env,
	query: string,
	maxResults: number,
	rotate = 0
): Promise<SearchOutcome> {
	const base = configuredProviders(env);
	if (!base.length) return { provider: 'none', results: [] };
	// Rotate the priority order by `rotate` so retries start elsewhere.
	const offset = ((rotate % base.length) + base.length) % base.length;
	const providers = [...base.slice(offset), ...base.slice(0, offset)];

	const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM' (UTC)
	let lastErr: unknown = null;
	for (const p of providers) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
		try {
			const results = await p.search(env, query, maxResults, controller.signal);
			// Count the consumed free-tier call (best-effort; never fail a search on it).
			await bumpUsage(env.DB, p.id, month).catch(() => {});
			return { provider: p.id, results };
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error(`all search providers failed: ${String(lastErr).slice(0, 200)}`);
}
