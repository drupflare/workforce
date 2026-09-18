import { describe, expect, it } from 'vitest';
import { emit, fanOut, httpSink, memorySink, nullSink } from '../../src/events.js';

describe('memorySink', () => {
	it('keeps what it was given', async () => {
		const sink = memorySink();
		await emit(sink, {
			name: 'worker.created',
			plane: 'cloudflare',
			target: 'account a',
			subject: 'api',
			now: () => 42
		});
		expect(sink.events[0]).toMatchObject({
			name: 'worker.created',
			plane: 'cloudflare',
			subject: 'api',
			at: 42
		});
	});
});

describe('nullSink', () => {
	it('discards without failing, which is what a caller with no sink gets', async () => {
		await expect(
			emit(nullSink, { name: 'worker.deleted', plane: 'x', target: 'y' })
		).resolves.toBeUndefined();
	});
});

describe('httpSink', () => {
	it('posts the event', async () => {
		const seen: string[] = [];
		const sink = httpSink('https://control.example/events', {
			token: 'tok',
			fetch: async (_url, init) => {
				seen.push(String(init?.body));
				return new Response(null, { status: 202 });
			}
		});
		await emit(sink, { name: 'version.deployed', plane: 'cloudflare', target: 't' });
		expect(seen[0]).toContain('version.deployed');
	});

	it('never fails the operation it describes', async () => {
		const sink = httpSink('https://control.example/events', {
			fetch: async () => {
				throw new Error('the control plane is down');
			}
		});
		await expect(
			emit(sink, { name: 'worker.created', plane: 'cloudflare', target: 't' })
		).resolves.toBeUndefined();
	});
});

describe('fanOut', () => {
	it('sends to every sink', async () => {
		const a = memorySink();
		const b = memorySink();
		await emit(fanOut(a, b), { name: 'fleet.applied', plane: 'cloudflare', target: 't' });
		expect(a.events.length).toBe(1);
		expect(b.events.length).toBe(1);
	});
});
