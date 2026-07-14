import type { ResearchOutcome } from './research';

/** Cap any stored JSON blob so a step row can't blow D1's value-size limit. */
const MAX_TRACE = 6000;
function clip(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return s.length > MAX_TRACE ? s.slice(0, MAX_TRACE) : s;
}

export interface JobOpts {
	maxRounds?: number;
	urlsPerRound?: number;
	extractBatch?: number;
}

/** Enqueue a research request. Returns immediately with the row in 'queued'. */
export async function enqueue(
	db: D1Database,
	id: string,
	question: string,
	opts: JobOpts,
	nowSec: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO research_job (id, question, status, opts, attempts, next_run_at, created_at, updated_at)
			 VALUES (?,?, 'queued', ?, 0, ?, ?, ?)`
		)
		.bind(id, question, JSON.stringify(opts ?? {}), nowSec, nowSec, nowSec)
		.run();
}

/** Requeue 'running' jobs whose claim went stale (worker crashed mid-run). */
export async function reclaimStale(db: D1Database, nowSec: number, staleSec = 600): Promise<void> {
	await db
		.prepare(
			`UPDATE research_job SET status='queued', running_at=NULL, updated_at=?
			 WHERE status='running' AND running_at IS NOT NULL AND running_at < ?`
		)
		.bind(nowSec, nowSec - staleSec)
		.run();
}

export interface ClaimedJob {
	id: string;
	question: string;
	opts: JobOpts;
	attempts: number;
}

/**
 * Claim the oldest eligible queued job (compare-and-swap on status so two
 * concurrent cron ticks can't grab the same one). Returns null if none ready.
 */
export async function claimNext(db: D1Database, nowSec: number): Promise<ClaimedJob | null> {
	const row = await db
		.prepare(
			`SELECT id, question, opts, attempts FROM research_job
			 WHERE status='queued' AND next_run_at <= ? ORDER BY created_at LIMIT 1`
		)
		.bind(nowSec)
		.first<{ id: string; question: string; opts: string | null; attempts: number }>();
	if (!row) return null;

	const claim = await db
		.prepare(
			`UPDATE research_job SET status='running', running_at=?, updated_at=? WHERE id=? AND status='queued'`
		)
		.bind(nowSec, nowSec, row.id)
		.run();
	if (!claim.meta.changes) return null; // lost the race
	return {
		id: row.id,
		question: row.question,
		opts: row.opts ? (JSON.parse(row.opts) as JobOpts) : {},
		attempts: row.attempts
	};
}

/** Replace a job's step trail with the latest attempt's steps. */
async function writeSteps(db: D1Database, id: string, outcome: ResearchOutcome, nowSec: number) {
	await db.prepare('DELETE FROM research_step WHERE job_id=?').bind(id).run();
	if (!outcome.steps.length) return;
	const stmt = db.prepare(
		`INSERT INTO research_step
		 (id, job_id, seq, round, phase, detail, provider, model, trace,
		  input_chars, output_chars, cost_usd, ms, ok, error, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
	);
	await db.batch(
		outcome.steps.map((s) =>
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
		)
	);
}

/** Mark a job done (status 'ok') and store its report + trail. */
export async function complete(
	db: D1Database,
	id: string,
	outcome: ResearchOutcome,
	nowSec: number
): Promise<void> {
	await db
		.prepare(
			`UPDATE research_job SET status='ok', report=?, sources=?, notes=?, models_used=?,
			  search_providers=?, rounds=?, cost_usd=?, ms=?, error=NULL, running_at=NULL, updated_at=?
			 WHERE id=?`
		)
		.bind(
			outcome.report || null,
			JSON.stringify(outcome.sources),
			JSON.stringify(outcome.notes),
			JSON.stringify(outcome.modelsUsed),
			JSON.stringify(outcome.searchProviders),
			outcome.rounds,
			outcome.costUsd,
			outcome.ms,
			nowSec,
			id
		)
		.run();
	await writeSteps(db, id, outcome, nowSec);
}

/** Backoff schedule for a retry after `attempts` failures (seconds). */
export function backoffSec(attempts: number): number {
	return Math.min(60 * 2 ** attempts, 1800);
}

/**
 * A processing attempt failed. Requeue with backoff if attempts remain, else
 * mark 'error'. Stores the (partial) step trail either way for debugging.
 */
export async function failOrRetry(
	db: D1Database,
	id: string,
	attempts: number,
	error: string,
	nowSec: number,
	outcome: ResearchOutcome | null,
	maxAttempts = 3
): Promise<'queued' | 'error'> {
	const nextAttempts = attempts + 1;
	if (outcome) await writeSteps(db, id, outcome, nowSec).catch(() => {});
	if (nextAttempts < maxAttempts) {
		await db
			.prepare(
				`UPDATE research_job SET status='queued', attempts=?, next_run_at=?, running_at=NULL,
				  error=?, updated_at=? WHERE id=?`
			)
			.bind(nextAttempts, nowSec + backoffSec(nextAttempts), error.slice(0, 500), nowSec, id)
			.run();
		return 'queued';
	}
	await db
		.prepare(
			`UPDATE research_job SET status='error', attempts=?, running_at=NULL, error=?, updated_at=? WHERE id=?`
		)
		.bind(nextAttempts, error.slice(0, 500), nowSec, id)
		.run();
	return 'error';
}

/**
 * Earliest time the queue has work: the minimum next_run_at among queued jobs
 * (≤ now means "process now"; a future value is a backed-off retry). null = the
 * queue is empty, so the DO can go dormant. Epoch seconds.
 */
export async function nextWakeAt(db: D1Database): Promise<number | null> {
	const row = await db
		.prepare(`SELECT MIN(next_run_at) AS w FROM research_job WHERE status='queued'`)
		.first<{ w: number | null }>();
	return row?.w ?? null;
}

/** Full job + its steps (for debugging / status). */
export async function getJob(db: D1Database, id: string) {
	const job = await db.prepare('SELECT * FROM research_job WHERE id = ?').bind(id).first();
	if (!job) return null;
	const steps = await db
		.prepare('SELECT * FROM research_step WHERE job_id = ? ORDER BY seq')
		.bind(id)
		.all();
	return { job, steps: steps.results };
}

/** Recent jobs (metadata only) for a history / queue list. */
export async function listJobs(db: D1Database, limit = 25) {
	const res = await db
		.prepare(
			`SELECT id, question, status, attempts, rounds, cost_usd, ms, models_used, search_providers,
			  created_at, updated_at
			 FROM research_job ORDER BY created_at DESC LIMIT ?`
		)
		.bind(Math.min(Math.max(limit, 1), 100))
		.all();
	return res.results;
}
