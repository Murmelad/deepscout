import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueue, claimNext, reclaimStale, nextWakeAt, STALE_SEC } from '../src/db.ts';

/**
 * Real SQLite (node:sqlite) + the real migration, behind a minimal D1-shaped
 * facade — just the prepare/bind/first/run surface the queue queries use. This
 * lets the queue-scheduling SQL be tested without a Workers runtime.
 */
function makeDb(): D1Database {
	const raw = new DatabaseSync(':memory:');
	raw.exec(readFileSync(new URL('../migrations/0000_init.sql', import.meta.url), 'utf8'));
	const facade = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first() {
							return raw.prepare(sql).get(...(args as [])) ?? null;
						},
						async run() {
							const r = raw.prepare(sql).run(...(args as []));
							return { meta: { changes: r.changes } };
						},
						async all() {
							return { results: raw.prepare(sql).all(...(args as [])) };
						}
					};
				}
			};
		}
	};
	return facade as unknown as D1Database;
}

test('nextWakeAt: empty queue → null (DO may go dormant)', async () => {
	const db = makeDb();
	assert.equal(await nextWakeAt(db), null);
});

test('nextWakeAt: queued job → its next_run_at', async () => {
	const db = makeDb();
	await enqueue(db, 'j1', 'q?', {}, 100);
	assert.equal(await nextWakeAt(db), 100);
});

test('a crashed running claim schedules a reap wake and is reclaimed', async () => {
	const db = makeDb();
	await enqueue(db, 'j1', 'q?', {}, 100);
	const job = await claimNext(db, 100);
	assert.equal(job?.id, 'j1');

	// Claim in flight (or crashed): the queue must NOT go dormant — it has to
	// wake at the reap time to reclaim the job if the claim went stale.
	const wake = await nextWakeAt(db);
	assert.equal(wake, 100 + STALE_SEC + 1);

	// Before the stale cutoff the claim is left alone…
	await reclaimStale(db, 100 + STALE_SEC);
	assert.equal(await claimNext(db, 100 + STALE_SEC), null);

	// …at the reap wake it is requeued and claimable again.
	await reclaimStale(db, wake!);
	assert.equal(await nextWakeAt(db), 100);
	const reclaimed = await claimNext(db, wake!);
	assert.equal(reclaimed?.id, 'j1');
});

test('nextWakeAt: min over queued retries and running reap times', async () => {
	const db = makeDb();
	await enqueue(db, 'j1', 'q?', {}, 100);
	await claimNext(db, 100); // running: reap at 100 + STALE_SEC + 1
	await enqueue(db, 'j2', 'q?', {}, 200); // queued: due at 200
	assert.equal(await nextWakeAt(db), 200);
});
