-- Per-provider search-call counter, bucketed by calendar month (UTC 'YYYY-MM'),
-- so the studio can draw a "how close to the free-tier limit" gauge. One row per
-- (provider, month); incremented once per successful search query. Tiny + cheap.

CREATE TABLE IF NOT EXISTS search_usage (
	provider TEXT NOT NULL,        -- search provider id (exa | tavily | serper | brave)
	month TEXT NOT NULL,           -- 'YYYY-MM' (UTC)
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (provider, month)
);
