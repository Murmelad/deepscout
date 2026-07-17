import type { Note, ResearchOutcome, Step } from './research';

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
	maxResultsPerQuery?: number;
	render?: boolean;
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

/** A 'running' claim older than this is presumed crashed and gets requeued. */
export const STALE_SEC = 600;

/** Requeue 'running' jobs whose claim went stale (worker crashed mid-run). */
export async function reclaimStale(
	db: D1Database,
	nowSec: number,
	staleSec = STALE_SEC
): Promise<void> {
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
	/** Notes/sources persisted by a prior attempt (present ⇒ resume at synthesis). */
	notes: Note[];
	sources: string[];
}

const parseArr = <T>(s: string | null): T[] => {
	if (!s) return [];
	try {
		const p = JSON.parse(s);
		return Array.isArray(p) ? (p as T[]) : [];
	} catch {
		return [];
	}
};

/**
 * Claim the oldest eligible queued job (compare-and-swap on status so two
 * concurrent cron ticks can't grab the same one). Returns null if none ready.
 * Carries any notes/sources a prior attempt saved, so the caller can resume at
 * synthesis instead of re-gathering.
 */
export async function claimNext(db: D1Database, nowSec: number): Promise<ClaimedJob | null> {
	const row = await db
		.prepare(
			`SELECT id, question, opts, attempts, notes, sources FROM research_job
			 WHERE status='queued' AND next_run_at <= ? ORDER BY created_at LIMIT 1`
		)
		.bind(nowSec)
		.first<{
			id: string;
			question: string;
			opts: string | null;
			attempts: number;
			notes: string | null;
			sources: string | null;
		}>();
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
		attempts: row.attempts,
		notes: parseArr<Note>(row.notes),
		sources: parseArr<string>(row.sources)
	};
}

/**
 * Replace a job's step trail with `steps`, atomically — the DELETE + INSERTs run
 * as one D1 batch (a transaction), so a concurrent poll of GET /research/:id
 * never observes an empty trail mid-write. Used for both the final trail and
 * live progress checkpoints.
 */
async function writeSteps(db: D1Database, id: string, steps: Step[], nowSec: number) {
	const del = db.prepare('DELETE FROM research_step WHERE job_id=?').bind(id);
	if (!steps.length) {
		await del.run();
		return;
	}
	const stmt = db.prepare(
		`INSERT INTO research_step
		 (id, job_id, seq, round, phase, detail, provider, model, trace,
		  input_chars, output_chars, cost_usd, ms, ok, error, created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
	);
	const inserts = steps.map((s) =>
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
	await db.batch([del, ...inserts]);
}

/**
 * Persist a live progress checkpoint mid-run: rewrite the step trail so a poll
 * sees steps as they complete. The job stays 'running'; the report, sources and
 * notes are written only by `complete()` at the end. Called a bounded number of
 * times per run (after planning + once per round) to stay within the free-tier
 * per-invocation budget.
 */
export async function saveProgress(db: D1Database, id: string, steps: Step[], nowSec: number) {
	await writeSteps(db, id, steps, nowSec);
}

/**
 * Persist the gathered notes + sources (called right before synthesis). Kept on
 * the job row so a later retry can resume at synthesis via `runResearch`'s
 * `resume` option instead of re-searching/-extracting. Guarded on 'running' so a
 * late write can't clobber an already-finished job.
 */
export async function saveNotes(
	db: D1Database,
	id: string,
	notes: Note[],
	sources: string[],
	nowSec: number
) {
	await db
		.prepare(
			`UPDATE research_job SET notes=?, sources=?, updated_at=? WHERE id=? AND status='running'`
		)
		.bind(JSON.stringify(notes), JSON.stringify(sources), nowSec, id)
		.run();
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
	await writeSteps(db, id, outcome.steps, nowSec);
}

/** Increment this month's search-call counter for a provider (best-effort). */
export async function bumpUsage(db: D1Database, provider: string, month: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO search_usage (provider, month, count) VALUES (?, ?, 1)
			 ON CONFLICT(provider, month) DO UPDATE SET count = count + 1`
		)
		.bind(provider, month)
		.run();
}

/** This month's per-provider search-call counts (for the usage gauge). */
export async function getUsage(
	db: D1Database,
	month: string
): Promise<{ provider: string; count: number }[]> {
	const res = await db
		.prepare(`SELECT provider, count FROM search_usage WHERE month = ? ORDER BY provider`)
		.bind(month)
		.all<{ provider: string; count: number }>();
	return res.results ?? [];
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
	// Retries are cheap now that a synth-only failure resumes from saved notes
	// (no re-gathering), so allow a few more attempts to ride out a rate limit.
	maxAttempts = 5
): Promise<'queued' | 'error'> {
	const nextAttempts = attempts + 1;
	if (outcome) await writeSteps(db, id, outcome.steps, nowSec).catch(() => {});
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
 * Earliest time the queue has work: the minimum of next_run_at among queued
 * jobs (≤ now means "process now"; a future value is a backed-off retry) and
 * the reap time of any 'running' claim — a crash mid-run must wake the DO to
 * reclaim the job, otherwise an otherwise-empty queue would go dormant over it
 * and strand it in 'running' forever. null = no queued or running jobs, so the
 * DO can go dormant. Epoch seconds.
 */
export async function nextWakeAt(db: D1Database, staleSec = STALE_SEC): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT MIN(w) AS w FROM (
				SELECT next_run_at AS w FROM research_job WHERE status='queued'
				UNION ALL
				SELECT running_at + ? FROM research_job WHERE status='running' AND running_at IS NOT NULL
			)`
		)
		// +1 so the alarm fires strictly after reclaimStale's `running_at < now - staleSec` cutoff.
		.bind(staleSec + 1)
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
