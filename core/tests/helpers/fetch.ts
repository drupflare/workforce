import type { Fetcher } from '../../src/client/fetch.js';

export interface StubCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: BodyInit | null | undefined;
}

export interface StubReply {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
	/** throw instead of answering, to drive the transport path */
	throws?: Error;
}

/** A fetch stand-in that records what it was asked and replays a queue of replies. */
export function stubFetch(replies: StubReply[]): { fetch: Fetcher; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const queue = [...replies];
	const fetch: Fetcher = async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body
		});
		const reply = queue.shift() ?? { status: 200, body: { success: true, result: null } };
		if (reply.throws !== undefined) throw reply.throws;
		return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
			status: reply.status ?? 200,
			headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) }
		});
	};
	return { fetch, calls };
}

export function envelope<T>(result: T, extra: Record<string, unknown> = {}): unknown {
	return { success: true, errors: [], messages: [], result, ...extra };
}

export function refusal(errors: { code?: number; message?: string }[]): unknown {
	return { success: false, errors, messages: [], result: null };
}

/** a clock and a sleep that advance together, so backoff is tested without waiting */
export function fakeClock(startMs = 1_700_000_000_000) {
	let now = startMs;
	const slept: number[] = [];
	return {
		now: () => now,
		sleep: async (ms: number) => {
			slept.push(ms);
			now += ms;
		},
		advance: (ms: number) => {
			now += ms;
		},
		slept
	};
}
