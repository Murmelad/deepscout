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
			if (opts.useCase === 'research-plan') {
				return { ...base, output: JSON.stringify({ queries: ['plan-a', 'plan-b'] }) };
			}
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

test('runResearch: plans focused queries before the first search', async () => {
	const { deps } = makeDeps();
	const searched: string[] = [];
	const orig = deps.search;
	deps.search = async (q, n) => {
		searched.push(q);
		return orig(q, n);
	};
	const out = await runResearch(deps, { question: 'big multifaceted question', maxRounds: 1 });
	const plan = out.steps.find((s) => s.phase === 'plan');
	assert.ok(plan?.ok, 'a plan step ran');
	assert.ok(
		searched.includes('plan-a') && searched.includes('plan-b'),
		'planned queries drove round 0'
	);
	assert.ok(
		!searched.includes('big multifaceted question'),
		'the raw question was not used as the search query'
	);
});

test('runResearch: checkpoints progress before completion', async () => {
	const { deps } = makeDeps();
	const checkpoints: number[] = [];
	deps.onProgress = (steps) => {
		checkpoints.push(steps.length);
	};
	await runResearch(deps, { question: 'q', maxRounds: 2 });
	// At least: once after planning, once per round — and each checkpoint sees
	// more steps than the last (monotonic growth of the trail).
	assert.ok(checkpoints.length >= 3, 'checkpointed after plan + each round');
	for (let i = 1; i < checkpoints.length; i++) {
		assert.ok(checkpoints[i] >= checkpoints[i - 1], 'step trail grows monotonically');
	}
});

test('runResearch: resume skips gathering and only synthesizes', async () => {
	const { deps } = makeDeps();
	const searched: string[] = [];
	const orig = deps.search;
	deps.search = async (q, n) => {
		searched.push(q);
		return orig(q, n);
	};
	let notesReady = 0;
	deps.onNotesReady = () => {
		notesReady++;
	};
	const out = await runResearch(deps, {
		question: 'q',
		resume: {
			notes: [{ claim: 'prior fact', url: 'https://x.example/' }],
			sources: ['https://x.example/']
		}
	});
	assert.equal(searched.length, 0, 'no search/extract when resuming');
	assert.equal(out.report, 'FINAL REPORT', 'still produced a report');
	assert.deepEqual(out.sources, ['https://x.example/'], 'sources carried from resume');
	assert.ok(
		out.notes.some((n) => n.claim === 'prior fact'),
		'prior notes fed to synthesis'
	);
	assert.equal(notesReady, 1, 'notes persisted once before synthesis');
});
