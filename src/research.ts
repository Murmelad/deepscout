import type { SearchResult } from './search/types';
import type { FetchedPage, InferResult } from './aigw';

/**
 * The research core, dependency-injected so it's testable with fakes (see
 * test/research.test.mjs). Pipeline per round:
 *   search → dedup vs the URL blacklist → fetch missing page text →
 *   partition into disjoint batches → fan-out extract (each model gets a
 *   distinct set, so no two cover the same URL) → gap-check for next round.
 * Then synthesize one cited report from all notes.
 *
 * Bounded for the Cloudflare free tier: batched fetch (≤10 URLs/subrequest) +
 * a handful of inference calls keeps a run well under the 50-subrequest cap.
 */

export interface ResearchDeps {
	search(query: string, maxResults: number): Promise<{ provider: string; results: SearchResult[] }>;
	fetchUrls(urls: string[]): Promise<FetchedPage[]>;
	infer(opts: {
		route?: string;
		models?: { provider: string; model: string }[];
		system?: string;
		text: string;
		json?: boolean;
		useCase?: string;
	}): Promise<InferResult>;
	now(): number;
	uuid(): string;
	log?(msg: string): void;
}

export interface ResearchOptions {
	question: string;
	maxRounds?: number;
	urlsPerRound?: number;
	extractBatch?: number;
	maxResultsPerQuery?: number;
}

export interface Note {
	claim: string;
	url: string;
}

export interface Step {
	seq: number;
	round: number;
	phase: 'search' | 'fetch' | 'extract' | 'gap' | 'synthesize';
	detail: string;
	provider?: string;
	model?: string;
	trace?: unknown;
	inputChars?: number;
	outputChars?: number;
	costUsd?: number;
	ms: number;
	ok: boolean;
	error?: string;
}

export interface ResearchOutcome {
	question: string;
	report: string;
	notes: Note[];
	sources: string[];
	steps: Step[];
	modelsUsed: string[];
	searchProviders: string[];
	rounds: number;
	costUsd: number;
	ms: number;
}

// --- Synthesis prefers Gemini (huge context); extraction uses the reasoning route.
const SYNTH_MODELS = [
	{ provider: 'gemini', model: 'gemini-2.5-flash' },
	{ provider: 'gemini', model: 'gemini-3-flash-preview' },
	{ provider: 'sambanova', model: 'DeepSeek-V3.2' }
];

function normalizeUrl(u: string): string {
	try {
		const url = new URL(u);
		url.hash = '';
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`;
	} catch {
		return u.trim();
	}
}

function chunk<T>(arr: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

/** Parse model JSON output tolerantly (strips ```json fences / prose wrapping). */
function safeJson<T>(s: string): T | null {
	if (!s) return null;
	const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced ? fenced[1] : s;
	try {
		return JSON.parse(body) as T;
	} catch {
		const m = body.match(/[[{][\s\S]*[\]}]/);
		if (m) {
			try {
				return JSON.parse(m[0]) as T;
			} catch {
				return null;
			}
		}
		return null;
	}
}

const EXTRACT_SYS =
	'You are a research extractor. From the SOURCES, extract only factual claims that ' +
	'help answer the QUESTION. Each claim must be self-contained and attributed to the ' +
	'exact source URL it came from. Ignore navigation/boilerplate. Respond ONLY with JSON: ' +
	'{"notes":[{"claim":"…","url":"…"}]}. Max 12 notes.';

const GAP_SYS =
	'You are a research planner. Given the QUESTION and the NOTES gathered so far, list up ' +
	'to 3 web search queries that would fill the most important remaining gaps. If the ' +
	'question is already well covered, return an empty list. Respond ONLY with JSON: ' +
	'{"queries":["…"]}.';

const SYNTH_SYS =
	'You are a research writer. Using ONLY the NOTES (each has a source URL), write a ' +
	'clear, well-structured markdown report answering the QUESTION. Cite sources inline as ' +
	'[n] linking to their URLs, and end with a "Sources" list. Do not invent facts beyond ' +
	'the notes; if evidence is thin or conflicting, say so.';

export async function runResearch(
	deps: ResearchDeps,
	options: ResearchOptions
): Promise<ResearchOutcome> {
	const started = deps.now();
	const maxRounds = Math.min(Math.max(options.maxRounds ?? 2, 1), 4);
	const urlsPerRound = Math.min(Math.max(options.urlsPerRound ?? 8, 1), 12);
	const extractBatch = Math.min(Math.max(options.extractBatch ?? 4, 1), 8);
	const maxResults = Math.min(Math.max(options.maxResultsPerQuery ?? 6, 1), 15);

	const steps: Step[] = [];
	const notes: Note[] = [];
	const seen = new Set<string>(); // the URL blacklist — never covered twice
	const modelsUsed = new Set<string>();
	const searchProviders = new Set<string>();
	let seq = 0;
	let costUsd = 0;

	const record = (s: Omit<Step, 'seq'>) => {
		steps.push({ ...s, seq: seq++ });
	};
	const noteModel = (r: InferResult) => {
		costUsd += r.costUsd;
		if (r.provider && r.model) modelsUsed.add(`${r.provider}/${r.model}`);
	};

	let queries = [options.question];
	let round = 0;
	for (; round < maxRounds; round++) {
		// 1. Search each query; collect candidates.
		const candidates: SearchResult[] = [];
		for (const q of queries) {
			const t0 = deps.now();
			try {
				const { provider, results } = await deps.search(q, maxResults);
				searchProviders.add(provider);
				candidates.push(...results);
				record({
					round,
					phase: 'search',
					detail: q,
					provider,
					outputChars: results.length,
					ms: deps.now() - t0,
					ok: true
				});
			} catch (e) {
				record({
					round,
					phase: 'search',
					detail: q,
					ms: deps.now() - t0,
					ok: false,
					error: String(e).slice(0, 300)
				});
			}
		}

		// Dedup against the blacklist, keep this round's fresh top-N.
		const fresh: SearchResult[] = [];
		for (const c of candidates) {
			const key = normalizeUrl(c.url);
			if (seen.has(key)) continue;
			seen.add(key);
			fresh.push(c);
			if (fresh.length >= urlsPerRound) break;
		}
		if (!fresh.length) {
			deps.log?.(`round ${round}: no fresh URLs, stopping`);
			break;
		}

		// 2. Fetch page text for results that didn't come with content.
		const needFetch = fresh.filter((r) => !r.content).map((r) => r.url);
		const fetchedByUrl = new Map<string, FetchedPage>();
		if (needFetch.length) {
			const t0 = deps.now();
			try {
				const pages = await deps.fetchUrls(needFetch);
				for (const p of pages) fetchedByUrl.set(p.url, p);
				const okCount = pages.filter((p) => p.ok).length;
				record({
					round,
					phase: 'fetch',
					detail: `${okCount}/${needFetch.length} pages ok`,
					trace: pages.map((p) => ({ url: p.url, ok: p.ok, chars: p.chars, error: p.error })),
					ms: deps.now() - t0,
					ok: true
				});
			} catch (e) {
				record({
					round,
					phase: 'fetch',
					detail: `${needFetch.length} urls`,
					ms: deps.now() - t0,
					ok: false,
					error: String(e).slice(0, 300)
				});
			}
		}

		const docs = fresh
			.map((r) => ({
				url: r.url,
				title: r.title,
				text: (r.content ?? fetchedByUrl.get(r.url)?.text ?? '').slice(0, 12_000)
			}))
			.filter((d) => d.text.length > 80);

		// 3. Partition into disjoint batches → fan-out extract (each model a
		//    distinct set of URLs, so work never overlaps).
		const batches = chunk(docs, extractBatch);
		const extractResults = await Promise.all(
			batches.map(async (batch, i) => {
				const text =
					`QUESTION: ${options.question}\n\nSOURCES:\n` +
					batch.map((d) => `--- ${d.url} (${d.title}) ---\n${d.text}`).join('\n\n');
				const t0 = deps.now();
				try {
					const r = await deps.infer({
						route: 'reasoning',
						system: EXTRACT_SYS,
						text,
						json: true,
						useCase: 'research-extract'
					});
					noteModel(r);
					const parsed = safeJson<{ notes?: Note[] }>(r.output);
					const got = (parsed?.notes ?? []).filter((n) => n.claim && n.url);
					record({
						round,
						phase: 'extract',
						detail: `batch ${i + 1}/${batches.length} (${batch.length} urls) → ${got.length} notes`,
						provider: r.provider ?? undefined,
						model: r.model ?? undefined,
						trace: r.trace,
						inputChars: text.length,
						outputChars: r.output.length,
						costUsd: r.costUsd,
						ms: deps.now() - t0,
						ok: true
					});
					return got;
				} catch (e) {
					record({
						round,
						phase: 'extract',
						detail: `batch ${i + 1}/${batches.length}`,
						ms: deps.now() - t0,
						ok: false,
						error: String(e).slice(0, 300)
					});
					return [] as Note[];
				}
			})
		);
		for (const arr of extractResults) notes.push(...arr);

		// 4. Gap-check → queries for the next round (skip after the last round).
		if (round < maxRounds - 1 && notes.length) {
			const t0 = deps.now();
			try {
				const text =
					`QUESTION: ${options.question}\n\nNOTES:\n` + notes.map((n) => `- ${n.claim}`).join('\n');
				const r = await deps.infer({
					route: 'reasoning',
					system: GAP_SYS,
					text,
					json: true,
					useCase: 'research-gap'
				});
				noteModel(r);
				const parsed = safeJson<{ queries?: string[] }>(r.output);
				const next = (parsed?.queries ?? [])
					.map((q) => String(q).trim())
					.filter(Boolean)
					.slice(0, 3);
				record({
					round,
					phase: 'gap',
					detail: next.length ? `next: ${next.join(' | ')}` : 'no gaps — done',
					provider: r.provider ?? undefined,
					model: r.model ?? undefined,
					trace: r.trace,
					costUsd: r.costUsd,
					ms: deps.now() - t0,
					ok: true
				});
				if (!next.length) {
					round++;
					break;
				}
				queries = next;
			} catch (e) {
				record({
					round,
					phase: 'gap',
					detail: 'gap check failed',
					ms: deps.now() - t0,
					ok: false,
					error: String(e).slice(0, 300)
				});
				round++;
				break;
			}
		}
	}

	// 5. Synthesize the report (Gemini big context; falls through to DeepSeek).
	let report = '';
	{
		const t0 = deps.now();
		const numbered = notes.map((n, i) => `[${i + 1}] ${n.claim} (${n.url})`).join('\n');
		const text = `QUESTION: ${options.question}\n\nNOTES:\n${numbered || '(no notes gathered)'}`;
		try {
			const r = await deps.infer({
				models: SYNTH_MODELS,
				system: SYNTH_SYS,
				text,
				useCase: 'research-synth'
			});
			noteModel(r);
			report = r.output;
			record({
				round,
				phase: 'synthesize',
				detail: `${notes.length} notes → report`,
				provider: r.provider ?? undefined,
				model: r.model ?? undefined,
				trace: r.trace,
				inputChars: text.length,
				outputChars: r.output.length,
				costUsd: r.costUsd,
				ms: deps.now() - t0,
				ok: true
			});
		} catch (e) {
			record({
				round,
				phase: 'synthesize',
				detail: 'synthesis failed',
				ms: deps.now() - t0,
				ok: false,
				error: String(e).slice(0, 300)
			});
		}
	}

	return {
		question: options.question,
		report,
		notes,
		sources: [...seen],
		steps,
		modelsUsed: [...modelsUsed],
		searchProviders: [...searchProviders],
		rounds: round,
		costUsd,
		ms: deps.now() - started
	};
}
