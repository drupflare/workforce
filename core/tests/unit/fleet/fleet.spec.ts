import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import { applyPlan, type ApplyCursor } from '../../../src/fleet/apply.js';
import {
	decodeTags,
	encodeTags,
	expired,
	matches,
	MAX_TAGS,
	planeInventory,
	storeInventory,
	TAG_KEYS,
	type InventoryRecord
} from '../../../src/fleet/inventory.js';
import { mapFleet } from '../../../src/fleet/map.js';
import { planFleet, type PlannedAction } from '../../../src/fleet/plan.js';
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

	it('reads a worker with the same name on another plane as a different worker', () => {
		const plan = planFleet(
			[record({ worker: 'api', plane: 'cloudflare', scope: 'account a' })],
			[record({ worker: 'api', plane: 'workerd', scope: 'node https://n.example' })]
		);
		expect(plan.unchanged).toEqual([]);
		expect(plan.create.map((a) => a.worker)).toEqual(['api']);
	});

	it('reads the same name in another account as a different worker', () => {
		const plan = planFleet(
			[record({ worker: 'api', scope: 'account a' })],
			[record({ worker: 'api', scope: 'account b' })]
		);
		expect(plan.unchanged).toEqual([]);
		expect(plan.create.map((a) => a.worker)).toEqual(['api']);
	});

	it('rejects a duplicate identity in either list', () => {
		expect(() => planFleet([record({ worker: 'a' }), record({ worker: 'a' })], [])).toThrow(
			UsageError
		);
		expect(() => planFleet([], [record({ worker: 'a' }), record({ worker: 'a' })])).toThrow(
			UsageError
		);
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
		expect(first.cursor?.states).toEqual(['succeeded', 'pending']);

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

	it('does not report done after failFast stops on a failure', async () => {
		const three = planFleet(
			[
				record({ worker: 'a', env: 'dev' }),
				record({ worker: 'b', env: 'dev' }),
				record({ worker: 'c', env: 'dev' })
			],
			[]
		);
		const report = await applyPlan(
			three,
			async (action) => {
				if (action.worker === 'a') throw new Error('refused');
			},
			{ concurrency: 1, failFast: true }
		);
		expect(report.done).toBe(false);
		expect(report.cursor?.states).toEqual(['failed', 'pending', 'pending']);
	});

	it('retries a failed action on resume instead of skipping it', async () => {
		let attempts = 0;
		const runner = async (action: PlannedAction) => {
			if (action.worker === 'a' && attempts++ === 0) throw new Error('refused');
		};
		const first = await applyPlan(plan, runner, { budgetActions: 1 });
		expect(first.failed.map((f) => f.worker)).toEqual(['a']);

		const second = await applyPlan(plan, runner, { budgetActions: 1, cursor: first.cursor });
		expect(second.applied).toEqual(['a']);

		const third = await applyPlan(plan, runner, { budgetActions: 1, cursor: second.cursor });
		expect(third.applied).toEqual(['b']);
		expect(third.done).toBe(true);
	});

	it('refuses a cursor made from a different plan', async () => {
		const first = await applyPlan(plan, async () => {}, { budgetActions: 1 });
		const other = planFleet(
			[record({ worker: 'a', env: 'prod' }), record({ worker: 'b', env: 'dev' })],
			[]
		);
		await expect(
			applyPlan(other, async () => {}, { cursor: first.cursor })
		).rejects.toBeInstanceOf(UsageError);
	});
});

describe('applyPlan crash recovery', () => {
	const three = planFleet(
		[
			record({ worker: 'a', env: 'dev' }),
			record({ worker: 'b', env: 'dev' }),
			record({ worker: 'c', env: 'dev' })
		],
		[]
	);

	/** b fails once; killAt stops the executor right after that transition is persisted */
	async function drive(killAt?: number) {
		const ledger: string[] = [];
		const attempts = new Map<string, number>();
		const runner = async (action: PlannedAction) => {
			const attempt = (attempts.get(action.worker) ?? 0) + 1;
			attempts.set(action.worker, attempt);
			if (action.worker === 'b' && attempt === 1) throw new Error('refused');
			ledger.push(action.worker);
		};

		let transitions = 0;
		let killed = false;
		let persisted: ApplyCursor | undefined;
		const onTransition = (cursor: ApplyCursor) => {
			transitions += 1;
			persisted = cursor;
			if (transitions === killAt) {
				killed = true;
				throw new Error('executor killed');
			}
		};

		let done = false;
		let cursor: ApplyCursor | undefined;
		for (let round = 0; !done && round < 10; round++) {
			try {
				const report = await applyPlan(three, runner, {
					concurrency: 1,
					cursor,
					onTransition
				});
				done = report.done;
				cursor = report.cursor;
			} catch (error) {
				if (!killed) throw error;
				// a fresh executor resumes from the last state that was persisted
				cursor = persisted;
			}
		}
		return { done, ledger, transitions, killed };
	}

	it('loses and repeats no action when the executor dies after any transition', async () => {
		const uninterrupted = await drive();
		expect(uninterrupted.done).toBe(true);
		expect(uninterrupted.transitions).toBe(8);

		for (let kill = 1; kill <= uninterrupted.transitions; kill++) {
			const run = await drive(kill);
			expect(run.killed, `kill at ${kill}`).toBe(true);
			expect(run.done, `kill at ${kill}`).toBe(true);
			expect([...run.ledger].sort(), `kill at ${kill}`).toEqual(['a', 'b', 'c']);
		}
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

	it('takes the plane kind and account scope from the plane it reads', async () => {
		const inventory = planeInventory({
			kind: 'cloudflare',
			target: 'account a',
			list: async () => [{ name: 'api', tags: [] }],
			get: async () => null
		} as never);
		const [only] = await inventory.list();
		expect(only?.plane).toBe('cloudflare');
		expect(only?.scope).toBe('account a');
	});
});
