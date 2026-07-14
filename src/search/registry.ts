import type { SearchProvider, SearchResult } from './types';
import { tavily } from './tavily';
import { brave } from './brave';

/**
 * Search providers in fall-through priority. Content-returning providers first
 * (Tavily gives page text → fewer fetches), then link-only (Brave). Add a
 * provider = one import + one line here + its key. More free-tier providers land
 * here after the search-provider research (Serper, Exa, Jina, …).
 */
const PROVIDERS: SearchProvider[] = [tavily, brave];

const SEARCH_TIMEOUT_MS = 15_000;

export interface SearchOutcome {
	provider: string;
	results: SearchResult[];
}

/** List configured providers, in priority order. */
export function configuredProviders(env: Env): SearchProvider[] {
	return PROVIDERS.filter((p) => p.configured(env));
}

/**
 * Run one query through the first configured provider that succeeds. Returns the
 * provider id used (for the debug trail) + results. Throws only if every
 * configured provider errors; returns empty results if none are configured.
 */
export async function search(env: Env, query: string, maxResults: number): Promise<SearchOutcome> {
	const providers = configuredProviders(env);
	if (!providers.length) return { provider: 'none', results: [] };

	let lastErr: unknown = null;
	for (const p of providers) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
		try {
			const results = await p.search(env, query, maxResults, controller.signal);
			return { provider: p.id, results };
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error(`all search providers failed: ${String(lastErr).slice(0, 200)}`);
}
