import { describe, expect, it } from 'vitest';
import { planSweep, removals, type PreviewRecord, type PullRequestState } from '../src/sweep.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const preview = (over: Partial<PreviewRecord> = {}): PreviewRecord => ({
	worker: 'api-pr-1',
	pr: 1,
	ttlAtMs: null,
	...over
});

const pull = (over: Partial<PullRequestState> = {}): PullRequestState => ({
	number: 1,
	state: 'open',
	updatedAtMs: NOW - DAY,
	...over
});

describe('planSweep', () => {
	it('keeps a preview whose pull request is open and active', () => {
		const [decision] = planSweep({
			previews: [preview()],
			pulls: [pull()],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(false);
		expect(decision?.reason).toBe('keep');
	});

	it('removes one whose pull request has closed', () => {
		const [decision] = planSweep({
			previews: [preview()],
			pulls: [pull({ state: 'closed' })],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(true);
		expect(decision?.reason).toBe('closed');
	});

	it('removes one whose pull request has gone quiet past the window', () => {
		const [decision] = planSweep({
			previews: [preview()],
			pulls: [pull({ updatedAtMs: NOW - 30 * DAY })],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(true);
		expect(decision?.reason).toBe('stale');
		expect(decision?.detail).toMatch(/30 days/);
	});

	it('removes one past its ttl whatever the pull request says', () => {
		const [decision] = planSweep({
			previews: [preview({ ttlAtMs: NOW - 1 })],
			pulls: [pull()],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(true);
		expect(decision?.reason).toBe('expired');
	});

	it('reports an orphan rather than removing it, because the listing may be partial', () => {
		const [decision] = planSweep({
			previews: [preview({ pr: 999 })],
			pulls: [pull()],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(false);
		expect(decision?.reason).toBe('orphaned');
	});

	it('leaves a worker it was not given a pull request for alone', () => {
		const [decision] = planSweep({
			previews: [preview({ worker: 'production', pr: null })],
			pulls: [],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decision?.remove).toBe(false);
		expect(decision?.detail).toMatch(/does not own it/);
	});

	it('gives every decision a reason, so a sweep can be audited', () => {
		const decisions = planSweep({
			previews: [preview({ worker: 'a' }), preview({ worker: 'b', pr: 2 })],
			pulls: [pull(), pull({ number: 2, state: 'closed' })],
			staleAfterMs: 14 * DAY,
			nowMs: NOW
		});
		expect(decisions.every((d) => d.detail !== '')).toBe(true);
		expect(removals(decisions).map((d) => d.worker)).toEqual(['b']);
	});
});
