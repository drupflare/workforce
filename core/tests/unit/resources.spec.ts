import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/client/budget.js';
import { UsageError } from '../../src/client/errors.js';
import { HttpClient } from '../../src/client/fetch.js';
import { D1_LIMITS, Resources } from '../../src/resources.js';
import { envelope, stubFetch, type StubReply } from '../helpers/fetch.js';

function resources(replies: StubReply[], plan?: 'free' | 'paid') {
	const { fetch, calls } = stubFetch(replies);
	const http = new HttpClient(() => ({ authorization: 'Bearer t' }), {
		fetch,
		budget: new Budget()
	});
	return { resources: new Resources(http, 'acct', { plan }), calls };
}

const databases = (count: number): unknown[] =>
	Array.from({ length: count }, (_, i) => ({ uuid: `db-${i}`, name: `db-${i}` }));

describe('Resources.createD1', () => {
	it('creates one when there is room', async () => {
		const { resources: r, calls } = resources([
			{ body: envelope(databases(2)) },
			{ body: envelope({ uuid: 'new-uuid', name: 'tenant-db' }) }
		]);
		const created = await r.createD1('tenant-db');
		expect(created.uuid).toBe('new-uuid');
		expect(calls[1]?.method).toBe('POST');
	});

	it('refuses at the free cap, naming the cap rather than relaying a quota error', async () => {
		const { resources: r } = resources([
			{ body: envelope(databases(D1_LIMITS.databasesFree)) }
		]);
		await expect(r.createD1('one-too-many')).rejects.toThrow(
			/already holds 10 D1 databases and the free plan allows 10/
		);
	});

	it('allows far more on paid, since the cap is the plan rather than the API', async () => {
		const { resources: r } = resources(
			[
				{ body: envelope(databases(D1_LIMITS.databasesFree)) },
				{ body: envelope({ uuid: 'x', name: 'y' }) }
			],
			'paid'
		);
		await expect(r.createD1('fine-on-paid')).resolves.toMatchObject({ uuid: 'x' });
	});

	it('refuses a name that already exists rather than creating a confusing second one', async () => {
		const { resources: r } = resources([{ body: envelope([{ uuid: 'a', name: 'taken' }]) }]);
		await expect(r.createD1('taken')).rejects.toBeInstanceOf(UsageError);
	});
});

describe('Resources KV and R2', () => {
	it('creates a KV namespace', async () => {
		const { resources: r } = resources([{ body: envelope({ id: 'ns', title: 'cache' }) }]);
		expect(await r.createKv('cache')).toEqual({ id: 'ns', title: 'cache' });
	});

	it('lists R2 buckets out of the wrapper the API uses', async () => {
		const { resources: r } = resources([
			{ body: envelope({ buckets: [{ name: 'assets', creation_date: '2026-01-01' }] }) }
		]);
		expect(await r.listR2()).toEqual([{ name: 'assets', createdAt: '2026-01-01' }]);
	});

	it('creates an R2 bucket', async () => {
		const { resources: r } = resources([{ body: envelope({ name: 'frames' }) }]);
		expect((await r.createR2('frames')).name).toBe('frames');
	});
});

describe('D1_LIMITS', () => {
	it('records the caps this library refuses against', () => {
		// these are published figures the refusals quote, so they are a contract rather than a threshold
		expect(D1_LIMITS.databasesFree).toBe(10);
		expect(D1_LIMITS.databasesPaid).toBe(50_000);
		expect(D1_LIMITS.maxStatementBytes).toBe(100_000);
		expect(D1_LIMITS.maxRowBytes).toBe(2_000_000);
	});
});
