/**
 * The response shapes the real API actually uses.
 *
 * Every assertion here is a body captured from `api.cloudflare.com` on 2026-09-18, not a guess. Both
 * were wrong in the first implementation, both passed the local plane because it had been written
 * from the same wrong assumption, and both failed the moment the integration lane ran. Pinning them
 * here is what keeps the mock honest.
 */

import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import { HttpClient } from '../../../src/client/fetch.js';
import { collect, itemsOf } from '../../../src/client/paginate.js';
import { cloudflare } from '../../../src/plane/cloudflare.js';
import { stubFetch, type StubReply } from '../../helpers/fetch.js';

function client(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	return {
		http: new HttpClient(() => ({ authorization: 'Bearer t' }), {
			fetch,
			budget: new Budget()
		}),
		plane: cloudflare({ accountId: 'acct', token: 't', fetch, budget: new Budget() }),
		calls
	};
}

describe('itemsOf', () => {
	it('takes a bare array, which is what GET /workers/scripts answers', () => {
		expect(itemsOf([1, 2])).toEqual([1, 2]);
	});

	it('takes an items wrapper, which is what GET /versions answers', () => {
		expect(itemsOf({ items: [1, 2] })).toEqual([1, 2]);
	});

	it('is empty for anything else rather than throwing "result is not iterable"', () => {
		expect(itemsOf(null)).toEqual([]);
		expect(itemsOf({ nothing: true })).toEqual([]);
		expect(itemsOf('a string')).toEqual([]);
	});
});

describe('the captured /versions body', () => {
	// captured verbatim, trimmed to one version
	const body = {
		result: {
			items: [
				{
					id: '6a56f045-1392-4c7e-8aea-e39b571fe6d3',
					number: 1,
					metadata: {
						created_on: '2026-09-18T06:52:06.227897Z',
						source: 'api',
						has_preview: true
					},
					annotations: { 'workers/triggered_by': 'upload' }
				}
			]
		},
		success: true,
		errors: null,
		messages: null,
		result_info: { page: 1, per_page: 10, count: 1, total_count: 1 }
	};

	it('pages out of the items wrapper', async () => {
		const { http } = client([{ body }]);
		const versions = await collect<{ id: string }>(http, '/x');
		expect(versions.map((v) => v.id)).toEqual(['6a56f045-1392-4c7e-8aea-e39b571fe6d3']);
	});

	it('does not loop forever when total_count equals what it already has', async () => {
		const { http, calls } = client([{ body }]);
		await collect(http, '/x');
		expect(calls.length).toBe(1);
	});
});

describe('the captured /scripts-search body', () => {
	// captured verbatim: `id` is a hex worker id here and the NAME arrives as script_name
	const body = {
		result: [
			{
				created_on: '2026-09-18T06:52:06.227897Z',
				modified_on: '2026-09-18T06:52:06.227897Z',
				id: 'a718c28c957048aca5523537464eb445',
				script_name: 'wf-probe-1'
			}
		],
		success: true,
		errors: [],
		messages: []
	};

	it('reads the name from script_name rather than from id', async () => {
		const { plane } = client([{ body }]);
		const found = await plane.get('wf-probe-1');
		expect(found?.name).toBe('wf-probe-1');
	});

	it('keeps the hex id, which is what Access applications key on', async () => {
		const { plane } = client([{ body }]);
		expect((await plane.get('wf-probe-1'))?.id).toBe('a718c28c957048aca5523537464eb445');
	});

	it('answers true for a worker that exists, which is the assertion that failed first', async () => {
		const { plane } = client([{ body }]);
		expect(await plane.exists('wf-probe-1')).toBe(true);
	});

	it('still reads GET /scripts, where id IS the name', async () => {
		const { plane } = client([
			{ body: { success: true, errors: [], result: [{ id: 'plain-name' }] } }
		]);
		expect((await plane.list()).map((w) => w.name)).toEqual(['plain-name']);
	});
});
