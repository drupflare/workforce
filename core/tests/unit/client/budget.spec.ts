import { describe, expect, it } from 'vitest';
import {
	ASSUMED_QUOTA,
	Budget,
	BudgetRegistry,
	readRateHeaders,
	readRateParam,
	readRetryAfter
} from '../../../src/client/budget.js';
import { LimitError } from '../../../src/client/errors.js';
import { fakeClock } from '../../helpers/fetch.js';

const headers = (init: Record<string, string>): Headers => new Headers(init);

describe('readRateParam', () => {
	it('reads a parameter out of a quoted policy header', () => {
		expect(readRateParam('"cloudflare";q=1200;w=300', 'q')).toBe(1200);
		expect(readRateParam('"cloudflare";q=1200;w=300', 'w')).toBe(300);
	});

	it('reads whichever order the parameters arrive in', () => {
		expect(readRateParam('r=17;t=42;"name"', 't')).toBe(42);
		expect(readRateParam('t=42, r=17', 'r')).toBe(17);
	});

	it('answers null rather than guessing when the parameter is absent', () => {
		expect(readRateParam('"cloudflare";q=1200', 'r')).toBeNull();
		expect(readRateParam(null, 'r')).toBeNull();
	});

	it('does not match a parameter that is only a substring of another', () => {
		expect(readRateParam('qr=99', 'r')).toBeNull();
	});
});

describe('readRateHeaders', () => {
	it('reads every field independently', () => {
		const reading = readRateHeaders(
			headers({ ratelimit: '"cf";r=42;t=88', 'ratelimit-policy': '"cf";q=1200;w=300' })
		);
		expect(reading).toEqual({
			remaining: 42,
			resetSeconds: 88,
			quota: 1200,
			windowSeconds: 300
		});
	});

	it('answers nulls when the response says nothing', () => {
		expect(readRateHeaders(headers({}))).toEqual({
			remaining: null,
			resetSeconds: null,
			quota: null,
			windowSeconds: null
		});
	});
});

describe('readRetryAfter', () => {
	it('reads a delay in seconds', () => {
		expect(readRetryAfter(headers({ 'retry-after': '30' }), 0)).toBe(30_000);
	});

	it('reads an HTTP date as a delay from now', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		const later = new Date(now + 45_000).toUTCString();
		expect(readRetryAfter(headers({ 'retry-after': later }), now)).toBe(45_000);
	});

	it('never answers a negative delay for a date in the past', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		const before = new Date(now - 60_000).toUTCString();
		expect(readRetryAfter(headers({ 'retry-after': before }), now)).toBe(0);
	});

	it('answers null when absent, which is not the same as zero', () => {
		expect(readRetryAfter(headers({}), 0)).toBeNull();
	});
});

describe('Budget', () => {
	it('holds the reserve back rather than spending the whole allowance', () => {
		const budget = new Budget({ reserve: 0.2, assumedQuota: 100 });
		expect(budget.floor()).toBe(20);
		expect(budget.snapshot().quota).toBe(100);
	});

	it('spends down to the floor and then waits for the window rather than throwing', async () => {
		const clock = fakeClock();
		const budget = new Budget({
			reserve: 0.5,
			assumedQuota: 10,
			assumedWindowSeconds: 60,
			concurrency: 1,
			now: clock.now,
			sleep: clock.sleep
		});
		for (let i = 0; i < 5; i += 1) {
			await budget.acquire();
			budget.release();
		}
		expect(budget.snapshot().remaining).toBe(5);

		await budget.acquire();
		budget.release();
		// it waited for the window instead of refusing, and the window rolled
		expect(clock.slept.length).toBe(1);
		expect(budget.snapshot().remaining).toBe(9);
	});

	it('refuses instead of waiting when the caller asks it to', async () => {
		const budget = new Budget({ reserve: 0.9, assumedQuota: 10, concurrency: 1 });
		// a fresh budget still has one request above the floor; it is the spend that crosses it
		budget.assertAvailable();
		await budget.acquire();
		budget.release();
		expect(() => budget.assertAvailable()).toThrow(LimitError);
	});

	it('takes the server count over its own, since the local count cannot see the dashboard', () => {
		const budget = new Budget({ assumedQuota: 1200 });
		budget.observe(
			headers({ ratelimit: '"cf";r=7;t=12', 'ratelimit-policy': '"cf";q=900;w=60' })
		);
		const snapshot = budget.snapshot();
		expect(snapshot.remaining).toBe(7);
		expect(snapshot.quota).toBe(900);
	});

	it('treats a 429 as authoritative and names the wait', () => {
		const clock = fakeClock();
		const budget = new Budget({ now: clock.now, sleep: clock.sleep });
		const wait = budget.penalise(headers({ 'retry-after': '120' }));
		expect(wait).toBe(120_000);
		expect(budget.snapshot().remaining).toBe(0);
	});

	it('falls back to the window when a 429 names no wait', () => {
		const budget = new Budget({ assumedWindowSeconds: 300 });
		expect(budget.penalise(headers({}))).toBe(300_000);
	});

	it('bounds how many requests are in flight at once', async () => {
		const budget = new Budget({ concurrency: 2, assumedQuota: ASSUMED_QUOTA });
		await budget.acquire();
		await budget.acquire();
		let third = false;
		const pending = budget.acquire().then(() => {
			third = true;
		});
		await Promise.resolve();
		expect(third).toBe(false);
		budget.release();
		await pending;
		expect(third).toBe(true);
	});
});

describe('BudgetRegistry', () => {
	it('shares one budget per credential and separates different ones', () => {
		const registry = new BudgetRegistry();
		expect(registry.for('token-a')).toBe(registry.for('token-a'));
		expect(registry.for('token-a')).not.toBe(registry.for('token-b'));
	});
});
