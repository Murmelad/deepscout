/**
 * Client for the ai-gw gateway. deepscout does no inference or page-fetching
 * itself — it calls ai-gw, which owns provider keys, fall-through, cost metering
 * and logging. Every response carries the winning provider/model + trace, which
 * we persist into the step debug trail.
 */

export interface FetchedPage {
	url: string;
	ok: boolean;
	status?: number;
	title?: string;
	chars?: number;
	text?: string;
	error?: string;
}

export interface InferResult {
	output: string;
	provider: string | null;
	model: string | null;
	costUsd: number;
	latencyMs: number;
	trace: unknown;
}

export class AigwClient {
	constructor(
		private baseUrl: string,
		private apiKey: string
	) {}

	private headers() {
		return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
	}

	/**
	 * POST /v1/fetch — up to 10 URLs per call → clean page text. `render:true`
	 * asks ai-gw for JS-rendered content (Browser Rendering); ai-gw caps how many
	 * it renders and degrades to plain fetch, so it's safe to pass freely.
	 */
	async fetchUrls(urls: string[], maxChars = 12_000, render = false): Promise<FetchedPage[]> {
		const out: FetchedPage[] = [];
		for (let i = 0; i < urls.length; i += 10) {
			const batch = urls.slice(i, i + 10);
			const res = await fetch(`${this.baseUrl}/v1/fetch`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({ urls: batch, maxChars, render })
			});
			if (!res.ok)
				throw new Error(`ai-gw /v1/fetch ${res.status}: ${(await res.text()).slice(0, 200)}`);
			const json = (await res.json()) as { results?: FetchedPage[] };
			out.push(...(json.results ?? []));
		}
		return out;
	}

	/**
	 * POST /v1/run — inference through a named route (or explicit models), with an
	 * optional saved systemPrompt or inline system. Returns output + the winning
	 * model + cost/trace for the debug trail.
	 */
	async run(opts: {
		route?: string;
		models?: { provider: string; model: string }[];
		system?: string;
		text: string;
		json?: boolean;
		useCase?: string;
	}): Promise<InferResult> {
		const body: Record<string, unknown> = {
			input: { text: opts.text, system: opts.system },
			json: opts.json,
			useCase: opts.useCase ?? 'research'
		};
		if (opts.models) body.models = opts.models;
		else body.route = opts.route;

		const res = await fetch(`${this.baseUrl}/v1/run`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(body)
		});
		const json = (await res.json().catch(() => ({}))) as {
			output?: string;
			provider?: string;
			model?: string;
			costUsd?: number;
			latencyMs?: number;
			trace?: unknown;
			error?: { message?: string };
		};
		if (!res.ok) {
			throw new Error(`ai-gw /v1/run ${res.status}: ${json.error?.message ?? 'error'}`);
		}
		return {
			output: json.output ?? '',
			provider: json.provider ?? null,
			model: json.model ?? null,
			costUsd: json.costUsd ?? 0,
			latencyMs: json.latencyMs ?? 0,
			trace: json.trace ?? null
		};
	}
}
