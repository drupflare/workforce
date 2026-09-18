import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import {
	ApiError,
	AuthError,
	LimitError,
	NotFoundError,
	TransportError
} from '../../../src/client/errors.js';
import { API_BASE, backoffMs, buildQuery, HttpClient } from '../../../src/client/fetch.js';
import { envelope, fakeClock, refusal, stubFetch } from '../../helpers/fetch.js';

const bearer = () => ({ authorization: 'Bearer test-token' });

function client(replies: Parameters<typeof stubFetch>[0], extra: Record<string, unknown> = {}) {
	const clock = fakeClock();
	const { fetch, calls } = stubFetch(replies);
	const http = new HttpClient(bearer, {
		fetch,
		budget: new Budget({ now: clock.now, sleep: clock.sleep }),
		sleep: clock.sleep,
		now: clock.now,
		...extra
	});
	return { http, calls, clock };
}

describe('buildQuery', () => {
	it('drops undefined rather than sending the string undefined', () => {
		expect(buildQuery({ a: 1, b: undefined, c: false })).toBe('?a=1&c=false');
	});

	it('is empty for no query at all', () => {
		expect(buildQuery(undefined)).toBe('');
		expect(buildQuery({ a: undefined })).toBe('');
	});
});

describe('HttpClient', () => {
	it('sends the credential and reads the envelope', async () => {
		const { http, calls } = client([{ body: envelope([{ id: 'one' }]) }]);
		const result = await http.request<{ id: string }[]>('/accounts/a/workers/scripts');
		expect(result).toEqual([{ id: 'one' }]);
		expect(calls[0]?.url).toBe(`${API_BASE}/accounts/a/workers/scripts`);
		expect(calls[0]?.headers.authorization).toBe('Bearer test-token');
	});

	it('drives a different base url without the caller changing anything else', async () => {
		const { http, calls } = client([{ body: envelope(null) }], {
			baseUrl: 'http://127.0.0.1:9100/client/v4'
		});
		await http.request('/accounts/a/workers/scripts');
		expect(calls[0]?.url).toBe('http://127.0.0.1:9100/client/v4/accounts/a/workers/scripts');
	});

	it('treats a 200 with success false as a refusal, not a result', async () => {
		const { http } = client([
			{ status: 200, body: refusal([{ code: 10000, message: 'Authentication error' }]) }
		]);
		await expect(http.request('/x')).rejects.toBeInstanceOf(ApiError);
	});

	it('carries the reported codes so a caller can branch without parsing prose', async () => {
		const { http } = client([
			{ status: 200, body: refusal([{ code: 10042, message: 'nope' }]) }
		]);
		const error = await http.request('/x').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).hasCode(10042)).toBe(true);
		expect((error as ApiError).hasCode(10000)).toBe(false);
	});

	it('names an auth failure rather than reporting it as a generic api error', async () => {
		const { http } = client([{ status: 403, body: refusal([{ message: 'forbidden' }]) }]);
		await expect(http.request('/x')).rejects.toBeInstanceOf(AuthError);
	});

	it('names a missing thing', async () => {
		const { http } = client([{ status: 404, body: refusal([{ message: 'gone' }]) }]);
		await expect(http.request('/x')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('reports a non-JSON body as transport rather than pretending it parsed', async () => {
		const { fetch } = stubFetch([]);
		const http = new HttpClient(bearer, {
			fetch: async () => new Response('<html>502</html>', { status: 502 })
		});
		await expect(http.request('/x')).rejects.toBeInstanceOf(TransportError);
	});

	it('retries a 500 and succeeds on the next answer', async () => {
		const { http, calls } = client([
			{ status: 500, body: refusal([{ message: 'boom' }]) },
			{ body: envelope({ ok: true }) }
		]);
		await expect(http.request('/x')).resolves.toEqual({ ok: true });
		expect(calls.length).toBe(2);
	});

	it('waits the named Retry-After on a 429 instead of guessing', async () => {
		const { http, clock } = client([
			{ status: 429, headers: { 'retry-after': '11' }, body: refusal([{ message: 'slow' }]) },
			{ body: envelope({ ok: true }) }
		]);
		await expect(http.request('/x')).resolves.toEqual({ ok: true });
		expect(clock.slept).toContain(11_000);
	});

	it('gives up on a 429 once the retries are spent, and says the account is blocked', async () => {
		const { http } = client(
			[
				{ status: 429, headers: { 'retry-after': '1' }, body: refusal([]) },
				{ status: 429, headers: { 'retry-after': '1' }, body: refusal([]) }
			],
			{ retries: 1 }
		);
		const error = await http.request('/x').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LimitError);
		expect((error as LimitError).retryAfterMs).toBe(1000);
	});

	it('retries a thrown transport failure and then raises it', async () => {
		const { http } = client(
			[{ throws: new Error('socket hang up') }, { throws: new Error('socket hang up') }],
			{ retries: 1 }
		);
		await expect(http.request('/x')).rejects.toBeInstanceOf(TransportError);
	});

	it('folds the response headers into the budget', async () => {
		const { http } = client([
			{
				body: envelope(null),
				headers: { ratelimit: '"cf";r=3;t=9', 'ratelimit-policy': '"cf";q=1200;w=300' }
			}
		]);
		await http.request('/x');
		expect(http.budget.snapshot().remaining).toBe(3);
	});

	it('hands back the raw response when the caller wants bytes', async () => {
		const { http } = client([{ body: { not: 'an envelope' } }]);
		const response = await http.send('/x');
		expect(response.status).toBe(200);
	});

	it('keeps result_info so a pager can see where it is', async () => {
		const { http } = client([
			{ body: envelope([1, 2], { result_info: { page: 1, total_pages: 3 } }) }
		]);
		const { info } = await http.requestPage<number[]>('/x');
		expect(info.total_pages).toBe(3);
	});
});

describe('backoffMs', () => {
	it('grows with the attempt and stays inside its own ceiling', () => {
		const half = backoffMs(0, () => 0);
		const full = backoffMs(0, () => 1);
		expect(half).toBeLessThanOrEqual(full);
		expect(backoffMs(3, () => 0)).toBeGreaterThan(backoffMs(0, () => 1));
		expect(backoffMs(99, () => 1)).toBeLessThanOrEqual(30_000);
	});
});
