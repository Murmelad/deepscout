import type { SearchProvider, SearchResult } from './types';

/**
 * Serper.dev — Google SERP proxy. 2,500 free queries, no card. Returns links +
 * snippets only (no page content), so its results go through ai-gw /v1/fetch.
 */
export const serper: SearchProvider = {
	id: 'serper',
	returnsContent: false,
	configured: (env) => Boolean(env.SERPER_API_KEY),
	async search(env, query, maxResults, signal): Promise<SearchResult[]> {
		const res = await fetch('https://google.serper.dev/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-API-KEY': env.SERPER_API_KEY as string },
			body: JSON.stringify({ q: query, num: Math.min(maxResults, 20) }),
			signal
		});
		if (!res.ok) {
			throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		const json = (await res.json()) as {
			organic?: Array<{ link?: string; title?: string; snippet?: string }>;
		};
		return (json.organic ?? [])
			.filter((r) => r.link)
			.map((r) => ({ url: r.link as string, title: r.title ?? '', snippet: r.snippet ?? '' }));
	}
};
