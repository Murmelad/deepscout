import type { SearchProvider, SearchResult } from './types';

/**
 * Exa — the most generous verified free tier (2026-07): ~20,000 requests/month,
 * no card, and it returns extracted page text inline via `contents`, so it
 * doubles as the fetch step for its results. First in the fall-through.
 */
export const exa: SearchProvider = {
	id: 'exa',
	returnsContent: true,
	configured: (env) => Boolean(env.EXA_API_KEY),
	async search(env, query, maxResults, signal): Promise<SearchResult[]> {
		const res = await fetch('https://api.exa.ai/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY as string },
			body: JSON.stringify({
				query,
				numResults: maxResults,
				type: 'auto',
				contents: { text: { maxCharacters: 12_000 }, highlights: true }
			}),
			signal
		});
		if (!res.ok) {
			throw new Error(`exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		const json = (await res.json()) as {
			results?: Array<{ url?: string; title?: string; text?: string; highlights?: string[] }>;
		};
		return (json.results ?? [])
			.filter((r) => r.url)
			.map((r) => ({
				url: r.url as string,
				title: r.title ?? '',
				snippet: (r.highlights?.join(' ') ?? r.text ?? '').slice(0, 500),
				content: r.text || undefined
			}));
	}
};
