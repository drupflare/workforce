import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import {
	assertPlan,
	createOperation,
	isComplete,
	parseOperation,
	planDigest,
	recordAction,
	serializeOperation,
	type PlannedOperationAction
} from '../../../src/fleet/operation.js';

const plan: PlannedOperationAction[] = [
	{ id: 'a1', worker: 'campus-www', target: 'acct-1/free', kind: 'create' },
	{ id: 'a2', worker: 'campus-news', target: 'acct-1/free', kind: 'update' }
];

describe('planDigest', () => {
	it('is stable for the same plan and changes when a target changes', async () => {
		expect(await planDigest(plan)).toBe(await planDigest(structuredClone(plan)));
		const moved = plan.map((a) => (a.id === 'a2' ? { ...a, target: 'acct-2/free' } : a));
		expect(await planDigest(moved)).not.toBe(await planDigest(plan));
	});
});

describe('createOperation', () => {
	it('binds the operation to the plan digest and starts every action pending', async () => {
		const op = await createOperation(plan, 1);
		expect(op.planDigest).toBe(await planDigest(plan));
		expect(op.epoch).toBe(1);
		expect(op.actions.map((a) => a.state)).toEqual(['pending', 'pending']);
	});

	it('rejects an action listed twice', async () => {
		await expect(createOperation([plan[0]!, plan[0]!], 1)).rejects.toThrow(UsageError);
	});
});

describe('recordAction', () => {
	it('refuses a write under a stale fencing epoch', async () => {
		const op = await createOperation(plan, 2);
		expect(() => recordAction(op, 'a1', 'succeeded', 1)).toThrow(UsageError);
	});

	it('records a terminal state for the named action only', async () => {
		const next = recordAction(await createOperation(plan, 2), 'a1', 'succeeded', 2);
		expect(next.actions.map((a) => a.state)).toEqual(['succeeded', 'pending']);
	});
});

describe('isComplete', () => {
	it('is true only when every action is observed terminal on its target', async () => {
		let op = await createOperation(plan, 1);
		op = recordAction(op, 'a1', 'succeeded', 1);
		expect(isComplete(op)).toBe(false);
		op = recordAction(op, 'a2', 'running', 1);
		expect(isComplete(op)).toBe(false);
		op = recordAction(op, 'a2', 'failed', 1);
		expect(isComplete(op)).toBe(true);
	});
});

describe('assertPlan', () => {
	it('refuses a plan that changed after the operation was created', async () => {
		const op = await createOperation(plan, 1);
		await expect(assertPlan(op, plan)).resolves.toBeUndefined();
		const changed = [{ ...plan[0]!, kind: 'delete' as const }, plan[1]!];
		await expect(assertPlan(op, changed)).rejects.toThrow(UsageError);
	});
});

describe('FleetOperation serialisation', () => {
	it('round-trips through its serialised form', async () => {
		const op = recordAction(await createOperation(plan, 3), 'a1', 'failed', 3);
		expect(parseOperation(serializeOperation(op))).toEqual(op);
	});

	it('rejects a malformed serialised form', () => {
		expect(() => parseOperation('{"epoch":1}')).toThrow(UsageError);
	});
});
