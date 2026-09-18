import { describe, expect, it } from 'vitest';
import {
	CLEAN_STATE,
	fairShare,
	fleetMeter,
	QUARANTINE_STRIKES,
	recordOutcome,
	rollup,
	RUNGS,
	SEVERITY,
	type Finding
} from '../../src/health.js';

const finding = (code: string, severity: Finding['severity'] = 'warn'): Finding => ({
	code,
	severity,
	scope: 'worker',
	context: 'because'
});

describe('recordOutcome', () => {
	it('clears the strikes on a clean pass', () => {
		const struck = { ...CLEAN_STATE, code: 'boom', strikes: 2 };
		expect(recordOutcome(struck, { ok: true }, 0).strikes).toBe(0);
	});

	it('does not leave quarantine on one good result, because that says nothing about the cause', () => {
		const quarantined = { ...CLEAN_STATE, rung: 'quarantine' as const, quarantinedAtMs: 5 };
		expect(recordOutcome(quarantined, { ok: true }, 10).rung).toBe('quarantine');
	});

	it('counts consecutive failures of the same code', () => {
		let state = CLEAN_STATE;
		state = recordOutcome(state, { ok: false, code: 'same' }, 0);
		state = recordOutcome(state, { ok: false, code: 'same' }, 1);
		expect(state.strikes).toBe(2);
	});

	it('resets the count for a different code, since two faults are not one condition', () => {
		let state = recordOutcome(CLEAN_STATE, { ok: false, code: 'one' }, 0);
		state = recordOutcome(state, { ok: false, code: 'one' }, 1);
		state = recordOutcome(state, { ok: false, code: 'two' }, 2);
		expect(state.strikes).toBe(1);
		expect(state.rung).toBe('observe');
	});

	it('quarantines at the strike limit', () => {
		let state = CLEAN_STATE;
		for (let at = 0; at < QUARANTINE_STRIKES; at += 1) {
			state = recordOutcome(state, { ok: false, code: 'durable' }, at);
		}
		expect(state.rung).toBe('quarantine');
		expect(state.quarantinedAtMs).toBe(QUARANTINE_STRIKES - 1);
	});

	it('keeps the ladder in order', () => {
		expect(RUNGS.indexOf('quarantine')).toBeGreaterThan(RUNGS.indexOf('observe'));
		expect(RUNGS.at(-1)).toBe('rollback');
	});
});

describe('fleetMeter', () => {
	it('sums what workers reported', () => {
		const meter = fleetMeter([
			{ worker: 'a', values: { rowsToday: 10, doRequestsToday: 5 } },
			{ worker: 'b', values: { rowsToday: 20, doRequestsToday: 7 } }
		]);
		expect(meter.totals.rowsToday).toBe(30);
		expect(meter.totals.doRequestsToday).toBe(12);
	});

	it('records a missing reading rather than counting it as zero', () => {
		const meter = fleetMeter([
			{ worker: 'a', values: { rowsToday: 10 } },
			{ worker: 'b', values: { rowsToday: null } }
		]);
		expect(meter.totals.rowsToday).toBe(10);
		expect(meter.missing.rowsToday).toEqual(['b']);
		// the distinction is the point: a sum that treats silence as zero reads as complete
		expect(meter.reporting).toBe(1);
		expect(meter.workers).toBe(2);
	});
});

describe('fairShare', () => {
	it('spreads what is left across the workers sharing it', () => {
		const share = fairShare({ allowance: 100_000, spent: 40_000, workers: 4 });
		expect(share.remaining).toBe(60_000);
		expect(share.perWorker).toBe(15_000);
		expect(share.used).toBeCloseTo(0.4);
	});

	it('does not go negative when the fleet has overspent', () => {
		const share = fairShare({ allowance: 100, spent: 150, workers: 2 });
		expect(share.remaining).toBe(0);
		expect(share.used).toBe(1);
	});

	it('handles a fleet of none without dividing by zero', () => {
		expect(fairShare({ allowance: 100, spent: 0, workers: 0 }).perWorker).toBe(100);
	});
});

describe('rollup', () => {
	it('reports the worst severity across the fleet', () => {
		const result = rollup([
			{ worker: 'a', findings: [finding('x', 'info')] },
			{ worker: 'b', findings: [finding('y', 'critical')] },
			{ worker: 'c', findings: [finding('z', 'warn')] }
		]);
		expect(result.worst).toBe('critical');
		expect(SEVERITY[result.worst as 'critical']).toBe(3);
	});

	it('counts findings by code, which is what a breaker keys on', () => {
		const result = rollup([
			{ worker: 'a', findings: [finding('same'), finding('same')] },
			{ worker: 'b', findings: [finding('other')] }
		]);
		expect(result.byCode).toEqual({ same: 2, other: 1 });
	});

	it('names the quarantined workers', () => {
		const result = rollup([
			{ worker: 'ok', findings: [] },
			{
				worker: 'bad',
				findings: [],
				state: { ...CLEAN_STATE, rung: 'quarantine', quarantinedAtMs: 1 }
			}
		]);
		expect(result.quarantined).toEqual(['bad']);
	});

	it('is null-worst for a healthy fleet rather than claiming info', () => {
		expect(rollup([{ worker: 'a', findings: [] }]).worst).toBeNull();
	});
});
