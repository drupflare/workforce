import { describe, expect, it } from 'vitest';
import { Access } from '../../src/access.js';
import { Budget } from '../../src/client/budget.js';
import { HttpClient } from '../../src/client/fetch.js';
import { envelope, stubFetch, type StubReply } from '../helpers/fetch.js';

function access(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	const http = new HttpClient(() => ({ authorization: 'Bearer t' }), {
		fetch,
		budget: new Budget()
	});
	return { access: new Access(http, 'acct'), calls };
}

describe('Access', () => {
	it('creates an app whose destination is the worker rather than a hostname', async () => {
		const { access: a, calls } = access([
			{
				body: envelope({
					id: 'app-1',
					name: 'preview',
					destinations: [{ worker_id: 'w1' }]
				})
			}
		]);
		const app = await a.create({ name: 'preview', workerId: 'w1' });
		expect(app.workerIds).toEqual(['w1']);
		const sent = JSON.parse(String(calls[0]?.body)) as {
			destinations: { type: string; worker_id: string }[];
		};
		expect(sent.destinations[0]).toEqual({ type: 'worker', worker_id: 'w1' });
	});

	it('can cover only preview deployments', async () => {
		const { access: a, calls } = access([{ body: envelope({ id: 'app', destinations: [] }) }]);
		await a.create({ name: 'p', workerId: 'w1', destination: 'preview_worker' });
		const sent = JSON.parse(String(calls[0]?.body)) as { destinations: { type: string }[] };
		expect(sent.destinations[0]?.type).toBe('preview_worker');
	});

	it('finds the app already covering a worker', async () => {
		const { access: a } = access([
			{
				body: envelope([
					{ id: 'other', destinations: [{ worker_id: 'w9' }] },
					{ id: 'mine', destinations: [{ worker_id: 'w1' }] }
				])
			}
		]);
		expect((await a.forWorker('w1'))?.id).toBe('mine');
	});

	it('ensure() reuses an existing app rather than creating a duplicate', async () => {
		const { access: a, calls } = access([
			{ body: envelope([{ id: 'existing', destinations: [{ worker_id: 'w1' }] }]) }
		]);
		const app = await a.ensure({ name: 'preview', workerId: 'w1' });
		expect(app.id).toBe('existing');
		expect(calls.length).toBe(1);
	});

	it('ensure() creates when nothing covers the worker yet', async () => {
		const { access: a, calls } = access([
			{ body: envelope([]) },
			{ body: envelope({ id: 'new', destinations: [{ worker_id: 'w1' }] }) }
		]);
		expect((await a.ensure({ name: 'preview', workerId: 'w1' })).id).toBe('new');
		expect(calls.length).toBe(2);
	});
});
