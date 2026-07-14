import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, type ResearchDeps } from '../src/research.ts';

/** Fake deps: deterministic search/fetch/infer so we can assert orchestration. */
function makeDeps(): { deps: ResearchDeps; calls: { extractBatches: string[][] } } {
	let clock = 0;
	const calls = { extractBatches: [] as string[][] };

	const deps: ResearchDeps = {
		async search(query) {
			// Round 1 query (the question) → A..E; the follow-up "q2" → A (dup) + F,G.
			if (query === 'q2') {
				return {
					provider: 'brave',
					results: [
						{ url: 'https://a.example/', title: 'A', snippet: '' }, // duplicate → must be blacklisted
						{ url: 'https://f.example/', title: 'F', snippet: '' },
						{ url: 'https://g.example/', title: 'G', snippet: '' }
					]
				};
			}
			return {
				provider: 'tavily',
				results: ['a', 'b', 'c', 'd', 'e'].map((x) => ({
					url: `https://${x}.example/`,
					title: x.toUpperCase(),
					snippet: ''
				}))
			};
		},
		async fetchUrls(urls) {
			return urls.map((url) => ({
				url,
				ok: true,
				chars: 500,
				text: `This is the substantive page content of ${url}. `.repeat(6)
			}));
		},
		async infer(opts) {
			const base = {
				provider: 'gemini',
				model: 'gemini-2.5-flash',
				costUsd: 0.001,
				latencyMs: 1,
				trace: []
			};
			if (opts.useCase === 'research-extract') {
				const urls = [...opts.text.matchAll(/--- (\S+) /g)].map((m) => m[1]);
				calls.extractBatches.push(urls);
				return {
					...base,
					output: JSON.stringify({ notes: urls.map((u) => ({ claim: `fact from ${u}`, url: u })) })
				};
			}
			if (opts.useCase === 'research-gap') {
				// Ask for one follow-up round, exactly once.
				return { ...base, output: JSON.stringify({ queries: ['q2'] }) };
			}
			// synthesize
			return { ...base, provider: 'gemini', model: 'gemini-2.5-flash', output: 'FINAL REPORT' };
		},
		now: () => clock++,
		uuid: () => `id-${clock}`
	};
	return { deps, calls };
}

test('runResearch: blacklist dedups across rounds', async () => {
	const { deps } = makeDeps();
	const out = await runResearch(deps, {
		question: 'what is x?',
		maxRounds: 2,
		urlsPerRound: 8,
		extractBatch: 4
	});
	// A..E from round 1, F,G from round 2; A must NOT appear twice.
	const hosts = out.sources.map((u) => new URL(u).host).sort();
	assert.deepEqual(hosts, [
		'a.example',
		'b.example',
		'c.example',
		'd.example',
		'e.example',
		'f.example',
		'g.example'
	]);
	assert.equal(new Set(hosts).size, hosts.length, 'sources must be unique');
});

test('runResearch: fan-out uses disjoint URL batches', async () => {
	const { deps, calls } = makeDeps();
	await runResearch(deps, { question: 'q', maxRounds: 2, urlsPerRound: 8, extractBatch: 4 });
	// Round 1: 5 urls → batches of [4,1]. Round 2: 2 urls → [2]. No url in two batches.
	const flat = calls.extractBatches.flat();
	assert.equal(new Set(flat).size, flat.length, 'no URL extracted by two batches');
	assert.ok(
		calls.extractBatches.some((b) => b.length === 4),
		'a full batch of 4'
	);
});

test('runResearch: produces report, notes, model + step trail', async () => {
	const { deps } = makeDeps();
	const out = await runResearch(deps, { question: 'q', maxRounds: 2 });
	assert.equal(out.report, 'FINAL REPORT');
	assert.ok(out.notes.length >= 5, 'notes gathered');
	assert.ok(out.modelsUsed.includes('gemini/gemini-2.5-flash'));
	assert.equal(out.rounds, 2, 'ran two rounds via the gap query');
	const phases = new Set(out.steps.map((s) => s.phase));
	for (const p of ['search', 'fetch', 'extract', 'gap', 'synthesize']) {
		assert.ok(phases.has(p as never), `step trail includes ${p}`);
	}
	assert.ok(out.costUsd > 0, 'cost accumulated');
});
