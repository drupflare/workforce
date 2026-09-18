import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/client/budget.js';
import { HttpClient } from '../../src/client/fetch.js';
import {
	MIN_SAMPLES,
	Observability,
	startTail,
	summariseCpu,
	type TelemetryEvent
} from '../../src/observability.js';
import { envelope, stubFetch, type StubReply } from '../helpers/fetch.js';

const event = (over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
	timestamp: 1,
	scriptName: 'api',
	outcome: 'ok',
	executionModel: 'stateless',
	cpuTimeMs: 1,
	wallTimeMs: 2,
	message: null,
	raw: {},
	...over
});

function api(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	const http = new HttpClient(() => ({ authorization: 'Bearer t' }), {
		fetch,
		budget: new Budget()
	});
	return { http, observability: new Observability(http, 'acct'), calls };
}

describe('summariseCpu', () => {
	it('summarises per execution model', () => {
		const report = summariseCpu([
			event({ executionModel: 'durableObject', cpuTimeMs: 10 }),
			event({ executionModel: 'durableObject', cpuTimeMs: 20 }),
			event({ executionModel: 'durableObject', cpuTimeMs: 30 })
		]);
		expect(report.byModel.durableObject?.n).toBe(3);
		expect(report.byModel.durableObject?.median).toBe(20);
		expect(report.byModel.durableObject?.spread).toBe(20);
	});

	it('flags a capture with stateless events and no durable-object event as a broken instrument', () => {
		const report = summariseCpu([
			event({ executionModel: 'stateless', cpuTimeMs: 1 }),
			event({ executionModel: 'stateless', cpuTimeMs: 0 })
		]);
		expect(report.instrumentFailure).toBe(true);
		expect(report.usable).toBe(false);
		expect(report.notes.join(' ')).toMatch(/instrument failure/);
	});

	it('does not flag a capture that has both models', () => {
		const report = summariseCpu([
			event({ executionModel: 'stateless', cpuTimeMs: 1 }),
			event({ executionModel: 'durableObject', cpuTimeMs: 40 })
		]);
		expect(report.instrumentFailure).toBe(false);
		expect(report.usable).toBe(true);
	});

	it('refuses to support an absolute at too small an n', () => {
		const report = summariseCpu([event({ executionModel: 'durableObject', cpuTimeMs: 100 })]);
		expect(report.notes.join(' ')).toMatch(new RegExp(`n=1`));
		expect(MIN_SAMPLES).toBeGreaterThan(1);
	});

	it('says an empty capture is not evidence rather than reporting zero', () => {
		const report = summariseCpu([]);
		expect(report.usable).toBe(false);
		expect(report.notes.join(' ')).toMatch(/not evidence of anything/);
	});

	it('names a wide spread so a median is not quoted alone', () => {
		const report = summariseCpu([
			event({ executionModel: 'durableObject', cpuTimeMs: 10 }),
			event({ executionModel: 'durableObject', cpuTimeMs: 900 }),
			event({ executionModel: 'durableObject', cpuTimeMs: 20 })
		]);
		expect(report.notes.join(' ')).toMatch(/spans 890 ms/);
	});
});

describe('Observability', () => {
	it('queries the telemetry endpoint rather than tail', async () => {
		const { observability, calls } = api([
			{ body: envelope({ events: { events: [{ scriptName: 'api', cpuTime: 5 }] } }) }
		]);
		const events = await observability.query({ from: 0, to: 1 });
		expect(events.length).toBe(1);
		expect(calls[0]?.url).toContain('/observability/telemetry/query');
	});

	it('counts requests for one script, which no per-object meter can produce', async () => {
		const { observability } = api([{ body: envelope({ events: { events: [{}, {}, {}] } }) }]);
		expect(await observability.requestCount('api', 0, 1)).toBe(3);
	});

	it('reads the distinct values of a key', async () => {
		const { observability } = api([
			{ body: envelope({ values: [{ value: 'api' }, { value: 'web' }] }) }
		]);
		expect(await observability.values('scriptName', 0, 1)).toEqual(['api', 'web']);
	});
});

describe('startTail', () => {
	it('returns the session url the API hands back', async () => {
		const { http } = api([
			{ body: envelope({ id: 'tail-1', url: 'wss://tail.example', expires_at: 'later' }) }
		]);
		const session = await startTail(http, 'acct', 'api');
		expect(session.url).toBe('wss://tail.example');
		expect(session.id).toBe('tail-1');
	});
});
