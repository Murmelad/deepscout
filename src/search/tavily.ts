import type { SearchProvider, SearchResult } from './types';

/**
 * Tavily — search API built for LLM agents. Returns a per-result `content`
 * snippet and (with include_raw_content) extracted page text, so it doubles as a
 * fetch for many pages. Free tier: ~1,000 credits/mo, no card. OpenAI-ish JSON.
 */
export const tavily: SearchProvider = {
	id: 'tavily',
	returnsContent: true,
	configured: (env) => Boolean(env.TAVILY_API_KEY),
	async search(env, query, maxResults, signal): Promise<SearchResult[]> {
		const res = await fetch('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				api_key: env.TAVILY_API_KEY,
				query,
				max_results: maxResults,
				search_depth: 'basic',
				include_raw_content: true
			}),
			signal
		});
		if (!res.ok) {
			throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		const json = (await res.json()) as {
			results?: Array<{ url?: string; title?: string; content?: string; raw_content?: string }>;
		};
		return (json.results ?? [])
			.filter((r) => r.url)
			.map((r) => ({
				url: r.url as string,
				title: r.title ?? '',
				snippet: r.content ?? '',
				content: r.raw_content || r.content || undefined
			}));
	}
};
