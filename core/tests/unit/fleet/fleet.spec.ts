import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import { applyPlan } from '../../../src/fleet/apply.js';
import {
	decodeTags,
	encodeTags,
	expired,
	matches,
	MAX_TAGS,
	storeInventory,
	TAG_KEYS,
	type InventoryRecord
} from '../../../src/fleet/inventory.js';
import { mapFleet } from '../../../src/fleet/map.js';
import { planFleet } from '../../../src/fleet/plan.js';
import { memoryStore } from '../../../src/store/index.js';

const record = (over: Partial<InventoryRecord> = {}): InventoryRecord => ({
	worker: 'api',
	plane: 'cloudflare',
	env: null,
	owner: null,
	ttlAtMs: null,
	revision: null,
	extra: {},
	lastSeenMs: null,
	...over
});

describe('tags', () => {
	it('stays inside the eight a script may carry', () => {
		expect(TAG_KEYS.length).toBeLessThanOrEqual(MAX_TAGS);
	});

	it('round-trips what it encodes', () => {
		const original = record({ env: 'dev', owner: 'gregory', ttlAtMs: 1234, revision: 'abc' });
		expect(decodeTags(encodeTags(original))).toEqual({
			env: 'dev',
			owner: 'gregory',
			ttlAtMs: 1234,
			revision: 'abc'
		});
	});

	it('writes nothing for a field that is not set', () => {
		expect(encodeTags(record())).toEqual([]);
	});

	it('ignores a tag it does not recognise rather than failing on it', () => {
		expect(decodeTags(['someone-elses-tag', 'wf:env=dev'])).toEqual({ env: 'dev' });
	});

	it('ignores a ttl that is not a number', () => {
		expect(decodeTags(['wf:ttl=soon']).ttlAtMs).toBeNull();
	});
});

describe('matches', () => {
	it('filters by env and owner', () => {
		const dev = record({ env: 'dev', owner: 'a' });
		expect(matches(dev, { env: 'dev' })).toBe(true);
		expect(matches(dev, { env: 'prod' })).toBe(false);
		expect(matches(dev, { owner: 'b' })).toBe(false);
	});

	it('takes a predicate for anything the tags do not cover', () => {
		const record9 = record({ extra: { kind: 'template' } });
		expect(matches(record9, { where: (r) => r.extra.kind === 'template' })).toBe(true);
	});
});

describe('expired', () => {
	it('finds only records whose ttl has passed', () => {
		const records = [
			record({ worker: 'old', ttlAtMs: 100 }),
			record({ worker: 'fresh', ttlAtMs: 10_000 }),
			record({ worker: 'forever', ttlAtMs: null })
		];
		expect(expired(records, 1000).map((r) => r.worker)).toEqual(['old']);
	});
});

describe('storeInventory', () => {
	it('round-trips a record with more than the tag budget can hold', async () => {
		const inventory = storeInventory(memoryStore(), 'cloudflare');
		await inventory.put(
			record({ worker: 'api', env: 'dev', extra: { kind: 'cms', cms: 'drupal', pr: 412 } })
		);
		const read = await inventory.get('api');
		expect(read?.extra).toEqual({ kind: 'cms', cms: 'drupal', pr: 412 });
	});

	it('lists and deletes', async () => {
		const inventory = storeInventory(memoryStore(), 'cloudflare');
		await inventory.put(record({ worker: 'a' }));
		await inventory.put(record({ worker: 'b' }));
		expect((await inventory.list()).length).toBe(2);
		await inventory.delete('a');
		expect((await inventory.list()).map((r) => r.worker)).toEqual(['b']);
	});
});

describe('mapFleet', () => {
	it('runs every item and keeps results in input order', async () => {
		const result = await mapFleet([1, 2, 3], async (n) => n * 2, { concurrency: 2 });
		expect(result.outcomes.map((o) => o.result)).toEqual([2, 4, 6]);
		expect(result.ok).toBe(true);
	});

	it('finishes the rest rather than stopping at the first failure', async () => {
		const result = await mapFleet([1, 2, 3], async (n) => {
			if (n === 2) throw new Error('nope');
			return n;
		});
		expect(result.failed.length).toBe(1);
		expect(result.succeeded.length).toBe(2);
		expect(result.ok).toBe(false);
	});

	it('stops early when the caller asked it to', async () => {
		let ran = 0;
		const result = await mapFleet(
			[1, 2, 3, 4, 5],
			async (n) => {
				ran += 1;
				if (n === 1) throw new Error('stop');
				return n;
			},
			{ concurrency: 1, failFast: true }
		);
		expect(ran).toBeLessThan(5);
		expect(result.ok).toBe(false);
	});

	it('bounds how many run at once', async () => {
		let inFlight = 0;
		let peak = 0;
		await mapFleet(
			[1, 2, 3, 4, 5, 6],
			async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
			},
			{ concurrency: 2 }
		);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('reports progress as it goes', async () => {
		const seen: number[] = [];
		await mapFleet([1, 2, 3], async (n) => n, {
			concurrency: 1,
			onProgress: (done) => seen.push(done)
		});
		expect(seen).toEqual([1, 2, 3]);
	});
});

describe('planFleet', () => {
	it('separates creates, updates and unchanged', () => {
		const plan = planFleet(
			[record({ worker: 'a', env: 'dev' }), record({ worker: 'new', env: 'dev' })],
			[record({ worker: 'a', env: 'prod' })]
		);
		expect(plan.create.map((a) => a.worker)).toEqual(['new']);
		expect(plan.update.map((a) => a.worker)).toEqual(['a']);
		expect(plan.update[0]?.changes[0]).toMatch(/env prod -> dev/);
	});

	it('leaves undesired workers alone unless asked to prune', () => {
		const desired = [record({ worker: 'a' })];
		const actual = [record({ worker: 'a' }), record({ worker: 'stranger' })];
		expect(planFleet(desired, actual).remove).toEqual([]);
		expect(planFleet(desired, actual, { prune: true }).remove.map((a) => a.worker)).toEqual([
			'stranger'
		]);
	});

	it('is empty when nothing differs', () => {
		const same = [record({ worker: 'a', env: 'dev' })];
		expect(planFleet(same, same).empty).toBe(true);
	});
});

describe('applyPlan', () => {
	const plan = planFleet(
		[record({ worker: 'a', env: 'dev' }), record({ worker: 'b', env: 'dev' })],
		[]
	);

	it('applies every action and reports what it did', async () => {
		const ran: string[] = [];
		const report = await applyPlan(plan, async (action) => {
			ran.push(action.worker);
		});
		expect(report.applied.sort()).toEqual(['a', 'b']);
		expect(report.done).toBe(true);
		expect(report.cursor).toBeUndefined();
	});

	it('hands back a cursor when its action budget runs out', async () => {
		const first = await applyPlan(plan, async () => {}, { budgetActions: 1 });
		expect(first.done).toBe(false);
		expect(first.cursor).toEqual({ index: 1 });

		const second = await applyPlan(plan, async () => {}, {
			budgetActions: 1,
			cursor: first.cursor
		});
		expect(second.done).toBe(true);
	});

	it('counts an unchanged worker as skipped rather than applied', async () => {
		const noop = planFleet(
			[record({ worker: 'same', env: 'dev' })],
			[record({ worker: 'same', env: 'dev' })]
		);
		const report = await applyPlan(noop, async () => {});
		expect(report.applied).toEqual([]);
		expect(report.skipped).toEqual(['same']);
	});

	it('records a failure without abandoning the rest', async () => {
		const report = await applyPlan(plan, async (action) => {
			if (action.worker === 'a') throw new Error('refused');
		});
		expect(report.failed.map((f) => f.worker)).toEqual(['a']);
		expect(report.applied).toEqual(['b']);
	});
});

describe('planeInventory delete', () => {
	it('refuses to forget a worker that still exists', async () => {
		const { planeInventory } = await import('../../../src/fleet/inventory.js');
		const inventory = planeInventory({
			kind: 'cloudflare',
			list: async () => [],
			get: async () => null,
			setTags: async (_n: string, t: string[]) => t
		} as never);
		await expect(inventory.delete('api')).rejects.toBeInstanceOf(UsageError);
	});
});
