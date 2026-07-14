import { DurableObject } from 'cloudflare:workers';
import { AigwClient } from './aigw';
import { search as runSearch } from './search/registry';
import { runResearch, type ResearchDeps } from './research';
import { claimNext, complete, failOrRetry, nextWakeAt, reclaimStale } from './db';

/**
 * The queue engine as a single Durable Object (`idFromName('singleton')`), so
 * jobs process one at a time, in order. It is **event-driven, not polled**:
 *
 *   - `POST /research` inserts a row and calls `kick()` → an alarm fires ~now.
 *   - `alarm()` processes ONE job, then reschedules to the next due time
 *     (immediately if more are queued, at the retry time for a backed-off job).
 *   - When the queue is empty it sets **no alarm** → the DO goes dormant (zero
 *     cost) until the next `kick()`.
 *
 * This replaces an every-minute cron: no idle ticks, wakes only for real work.
 */
export class ResearchQueue extends DurableObject<Env> {
	/** Ensure an alarm fires soon (called on enqueue / manual nudge). */
	async kick(): Promise<void> {
		const target = Date.now() + 500;
		const cur = await this.ctx.storage.getAlarm();
		if (cur === null || cur > target) await this.ctx.storage.setAlarm(target);
	}

	/** Alarm handler: process one job, then reschedule (or go dormant). */
	async alarm(): Promise<void> {
		await this.processOne();
		await this.reschedule();
	}

	/** Manual nudge (POST /drain): process one now and report it. */
	async drainNow(): Promise<{ id: string; status: string } | null> {
		const r = await this.processOne();
		await this.reschedule();
		return r;
	}

	private deps(attempt: number): ResearchDeps {
		const aigw = new AigwClient(this.env.AIGW_BASE_URL, this.env.AIGW_API_KEY);
		return {
			search: (q, n) => runSearch(this.env, q, n, attempt),
			fetchUrls: (urls) => aigw.fetchUrls(urls),
			infer: (opts) => aigw.run(opts),
			now: () => Date.now(),
			uuid: () => crypto.randomUUID()
		};
	}

	private async processOne(): Promise<{ id: string; status: string } | null> {
		const db = this.env.DB;
		let nowSec = Math.floor(Date.now() / 1000);
		await reclaimStale(db, nowSec);
		const job = await claimNext(db, nowSec);
		if (!job) return null;

		try {
			const outcome = await runResearch(this.deps(job.attempts), {
				question: job.question,
				maxRounds: job.opts.maxRounds,
				urlsPerRound: job.opts.urlsPerRound,
				extractBatch: job.opts.extractBatch
			});
			nowSec = Math.floor(Date.now() / 1000);
			if (outcome.report) {
				await complete(db, job.id, outcome, nowSec);
				return { id: job.id, status: 'ok' };
			}
			const status = await failOrRetry(
				db,
				job.id,
				job.attempts,
				'no report produced',
				nowSec,
				outcome
			);
			return { id: job.id, status };
		} catch (e) {
			nowSec = Math.floor(Date.now() / 1000);
			const status = await failOrRetry(db, job.id, job.attempts, String(e), nowSec, null);
			return { id: job.id, status };
		}
	}

	/** Wake for the next due job/retry, or go dormant if the queue is empty. */
	private async reschedule(): Promise<void> {
		const wakeSec = await nextWakeAt(this.env.DB);
		if (wakeSec === null) {
			await this.ctx.storage.deleteAlarm(); // dormant — next kick() revives us
			return;
		}
		const at = Math.max(wakeSec * 1000, Date.now() + 500);
		await this.ctx.storage.setAlarm(at);
	}
}
