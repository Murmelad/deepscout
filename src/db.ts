import type { ResearchOutcome } from './research';

/** Cap any stored JSON blob so a step row can't blow D1's value-size limit. */
const MAX_TRACE = 6000;
function clip(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return s.length > MAX_TRACE ? s.slice(0, MAX_TRACE) : s;
}

/**
 * Persist a finished (or failed) run: one research_job row + a research_step row
 * per pipeline step. This is the debug trail — what was searched/fetched, which
 * model won each inference, cost and timing — kept queryable for later.
 */
export async function saveRun(
	db: D1Database,
	id: string,
	outcome: ResearchOutcome,
	status: 'ok' | 'error',
	error: string | null,
	nowSec: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO research_job
			 (id, question, status, report, sources, notes, models_used, search_providers,
			  rounds, cost_usd, ms, error, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
		)
		.bind(
			id,
			outcome.question,
			status,
			outcome.report || null,
			JSON.stringify(outcome.sources),
			JSON.stringify(outcome.notes),
			JSON.stringify(outcome.modelsUsed),
			JSON.stringify(outcome.searchProviders),
			outcome.rounds,
			outcome.costUsd,
			outcome.ms,
			error,
			nowSec,
			nowSec
		)
		.run();

	if (outcome.steps.length) {
		const stmt = db.prepare(
			`INSERT INTO research_step
			 (id, job_id, seq, round, phase, detail, provider, model, trace,
			  input_chars, output_chars, cost_usd, ms, ok, error, created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
		);
		const rows = outcome.steps.map((s) =>
			stmt.bind(
				`${id}:${s.seq}`,
				id,
				s.seq,
				s.round,
				s.phase,
				clip(s.detail),
				s.provider ?? null,
				s.model ?? null,
				clip(s.trace),
				s.inputChars ?? null,
				s.outputChars ?? null,
				s.costUsd ?? null,
				s.ms,
				s.ok ? 1 : 0,
				s.error ?? null,
				nowSec
			)
		);
		await db.batch(rows);
	}
}

/** Full job + its steps (for debugging a run). */
export async function getJob(db: D1Database, id: string) {
	const job = await db.prepare('SELECT * FROM research_job WHERE id = ?').bind(id).first();
	if (!job) return null;
	const steps = await db
		.prepare('SELECT * FROM research_step WHERE job_id = ? ORDER BY seq')
		.bind(id)
		.all();
	return { job, steps: steps.results };
}

/** Recent jobs (metadata only) for a history list. */
export async function listJobs(db: D1Database, limit = 25) {
	const res = await db
		.prepare(
			`SELECT id, question, status, rounds, cost_usd, ms, models_used, search_providers, created_at
			 FROM research_job ORDER BY created_at DESC LIMIT ?`
		)
		.bind(Math.min(Math.max(limit, 1), 100))
		.all();
	return res.results;
}
