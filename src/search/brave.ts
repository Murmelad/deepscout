import type { SearchProvider, SearchResult } from './types';

/**
 * Brave Search API — independent index, JSON results (links + descriptions, no
 * page content, so the orchestrator fetches them via ai-gw). Free tier exists
 * (rate-limited). Key sent as the X-Subscription-Token header.
 */
export const brave: SearchProvider = {
	id: 'brave',
	returnsContent: false,
	configured: (env) => Boolean(env.BRAVE_API_KEY),
	async search(env, query, maxResults, signal): Promise<SearchResult[]> {
		const u = new URL('https://api.search.brave.com/res/v1/web/search');
		u.searchParams.set('q', query);
		u.searchParams.set('count', String(Math.min(maxResults, 20)));
		const res = await fetch(u, {
			headers: {
				accept: 'application/json',
				'x-subscription-token': env.BRAVE_API_KEY as string
			},
			signal
		});
		if (!res.ok) {
			throw new Error(`brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		const json = (await res.json()) as {
			web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
		};
		return (json.web?.results ?? [])
			.filter((r) => r.url)
			.map((r) => ({
				url: r.url as string,
				title: r.title ?? '',
				snippet: r.description ?? ''
			}));
	}
};
