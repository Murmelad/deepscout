// Bindings + secrets for deepscout. `wrangler types` regenerates the binding
// half from wrangler.jsonc; this file also declares the secrets (from .dev.vars /
// wrangler secret put) so the code reads them type-safely.
declare global {
	interface Env {
		DB: D1Database;
		AIGW_BASE_URL: string;
		AIGW_API_KEY: string;
		EXA_API_KEY?: string;
		TAVILY_API_KEY?: string;
		SERPER_API_KEY?: string;
		BRAVE_API_KEY?: string;
		DEEPSCOUT_TOKEN?: string;
	}
}

export {};
