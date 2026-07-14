-- deepscout schema: research jobs + a full step-level debug trail.
-- Kept lean for the D1 free tier (100k writes/day, 5 GB): ~10-20 step rows per
-- job, large payloads truncated. Enough to debug a run and re-fetch its sources.

CREATE TABLE IF NOT EXISTS research_job (
	id TEXT PRIMARY KEY,
	question TEXT NOT NULL,
	status TEXT NOT NULL,          -- 'queued' | 'running' | 'ok' | 'error'
	opts TEXT,                     -- json: { maxRounds?, urlsPerRound?, extractBatch? }
	report TEXT,                   -- final synthesized markdown report
	sources TEXT,                  -- json: [url, …] every source consulted
	notes TEXT,                    -- json: extracted claims/notes
	models_used TEXT,              -- json: distinct ["provider/model", …]
	search_providers TEXT,         -- json: distinct search providers used
	rounds INTEGER,
	cost_usd REAL,                 -- sum of ai-gw costUsd (list-price equivalent)
	ms INTEGER,
	error TEXT,
	-- queue bookkeeping (cron-drained; Cloudflare Queues are paid-only)
	attempts INTEGER NOT NULL DEFAULT 0,
	next_run_at INTEGER NOT NULL DEFAULT 0,  -- epoch sec; eligible when <= now
	running_at INTEGER,                      -- claim time; stale claims are reaped
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_step (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	seq INTEGER NOT NULL,          -- order within the job
	round INTEGER,
	phase TEXT NOT NULL,           -- 'search' | 'fetch' | 'extract' | 'gap' | 'synthesize'
	detail TEXT,                   -- human summary (query / url count / batch idx)
	provider TEXT,                 -- search provider id, or winning LLM provider
	model TEXT,                    -- winning LLM model (from the ai-gw trace)
	trace TEXT,                    -- json: ai-gw attempt trace or fetch results (truncated)
	input_chars INTEGER,
	output_chars INTEGER,
	cost_usd REAL,
	ms INTEGER,
	ok INTEGER NOT NULL,           -- 1/0
	error TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_step_job ON research_step (job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_created ON research_job (created_at);
-- The cron picks the oldest eligible queued job.
CREATE INDEX IF NOT EXISTS idx_job_queue ON research_job (status, next_run_at, created_at);
