import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import { HttpClient } from '../../../src/client/fetch.js';
import { collect, hasMore, paginate } from '../../../src/client/paginate.js';
import { envelope, stubFetch } from '../../helpers/fetch.js';

const bearer = () => ({ authorization: 'Bearer t' });

function client(replies: Parameters<typeof stubFetch>[0]) {
	const { fetch, calls } = stubFetch(replies);
	return { http: new HttpClient(bearer, { fetch, budget: new Budget() }), calls };
}

describe('hasMore', () => {
	it('follows a cursor when one is present', () => {
		expect(hasMore({ cursor: 'abc' }, 0)).toBe(true);
		expect(hasMore({ cursor: '' }, 0)).toBe(false);
	});

	it('follows page counts', () => {
		expect(hasMore({ page: 1, total_pages: 3 }, 20)).toBe(true);
		expect(hasMore({ page: 3, total_pages: 3 }, 60)).toBe(false);
	});

	it('follows a total when that is all it has', () => {
		expect(hasMore({ total_count: 10 }, 4)).toBe(true);
		expect(hasMore({ total_count: 10 }, 10)).toBe(false);
	});

	it('stops when the envelope says nothing at all', () => {
		expect(hasMore({}, 0)).toBe(false);
	});
});

describe('paginate', () => {
	it('walks numbered pages to the end', async () => {
		const { http, calls } = client([
			{ body: envelope(['a', 'b'], { result_info: { page: 1, total_pages: 2 } }) },
			{ body: envelope(['c'], { result_info: { page: 2, total_pages: 2 } }) }
		]);
		expect(await collect<string>(http, '/x')).toEqual(['a', 'b', 'c']);
		expect(calls.length).toBe(2);
		expect(calls[1]?.url).toContain('page=2');
	});

	it('follows a cursor when the endpoint uses one', async () => {
		const { http, calls } = client([
			{ body: envelope(['a'], { result_info: { cursor: 'next-1' } }) },
			{ body: envelope(['b'], { result_info: { cursor: '' } }) }
		]);
		expect(await collect<string>(http, '/x')).toEqual(['a', 'b']);
		expect(calls[1]?.url).toContain('cursor=next-1');
		// once a cursor is in play the page number is dropped rather than sent alongside it
		expect(calls[1]?.url).not.toContain('page=');
	});

	it('stops on an empty page even when the envelope still claims more', async () => {
		const { http, calls } = client([
			{ body: envelope(['a'], { result_info: { page: 1, total_pages: 9 } }) },
			{ body: envelope([], { result_info: { page: 2, total_pages: 9 } }) }
		]);
		expect(await collect<string>(http, '/x')).toEqual(['a']);
		expect(calls.length).toBe(2);
	});

	it('stops at the caller limit without fetching another page', async () => {
		const { http, calls } = client([
			{ body: envelope(['a', 'b', 'c'], { result_info: { page: 1, total_pages: 5 } }) }
		]);
		const seen: string[] = [];
		for await (const item of paginate<string>(http, '/x', { limit: 2 })) seen.push(item);
		expect(seen).toEqual(['a', 'b']);
		expect(calls.length).toBe(1);
	});

	it('passes per_page through and keeps the caller query', async () => {
		const { http, calls } = client([{ body: envelope([]) }]);
		await collect(http, '/x', { perPage: 50, query: { name: 'wf' } });
		expect(calls[0]?.url).toContain('per_page=50');
		expect(calls[0]?.url).toContain('name=wf');
	});
});
