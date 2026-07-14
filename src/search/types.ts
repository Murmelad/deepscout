/** A normalised search hit. `content` is set only by providers that return page
 *  text (e.g. Tavily) — those save the orchestrator a separate fetch. */
export interface SearchResult {
	url: string;
	title: string;
	snippet: string;
	content?: string;
}

/** A search provider adapter. `configured` gates it out of the fall-through when
 *  its key is absent (same pattern as ai-gw providers). */
export interface SearchProvider {
	id: string;
	configured(env: Env): boolean;
	/** Throw on any error — the registry advances to the next provider. */
	search(env: Env, query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]>;
	/** True if this provider returns usable page `content` (fewer fetches). */
	returnsContent: boolean;
}
