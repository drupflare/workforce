import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import {
	d1Index,
	hybridStore,
	kvIndex,
	memoryStore,
	noStore,
	r2Frames,
	type D1Like,
	type KVLike,
	type R2Like
} from '../../src/store/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function fakeR2(): R2Like & { objects: Map<string, Uint8Array> } {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		async put(key, value) {
			objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
		},
		async get(key) {
			const found = objects.get(key);
			if (found === undefined) return null;
			return {
				async arrayBuffer() {
					const copy = new ArrayBuffer(found.byteLength);
					new Uint8Array(copy).set(found);
					return copy;
				}
			};
		},
		async head(key) {
			return objects.has(key) ? {} : null;
		},
		async delete(key) {
			objects.delete(key);
		}
	};
}

function fakeKv(): KVLike {
	const store = new Map<string, string>();
	return {
		async put(key, value) {
			store.set(key, value);
		},
		async get(key) {
			return store.get(key) ?? null;
		},
		async delete(key) {
			store.delete(key);
		},
		async list(options = {}) {
			const keys = [...store.keys()]
				.filter((k) => k.startsWith(options.prefix ?? ''))
				.slice(0, options.limit ?? Infinity)
				.map((name) => ({ name }));
			return { keys };
		}
	};
}

/** an in-memory D1 that understands only the four statements the index issues */
function fakeD1(): D1Like {
	const rows = new Map<
		string,
		{ kind: string; id: string; data: string; updated_at_ms: number }
	>();
	const key = (kind: string, id: string): string => `${kind} ${id}`;
	return {
		prepare(query: string) {
			return {
				bind(...values: unknown[]) {
					return {
						async run() {
							if (query.startsWith('INSERT')) {
								const [kind, id, data, at] = values as [
									string,
									string,
									string,
									number
								];
								rows.set(key(kind, id), { kind, id, data, updated_at_ms: at });
							}
							if (query.startsWith('DELETE')) {
								const [kind, id] = values as [string, string];
								rows.delete(key(kind, id));
							}
							return {};
						},
						async all<T>() {
							const [kind, like] = values as [string, string];
							const prefix = like.replace(/%$/, '');
							return {
								results: [...rows.values()]
									.filter((r) => r.kind === kind && r.id.startsWith(prefix))
									.sort((a, b) => a.id.localeCompare(b.id)) as T[]
							};
						},
						async first<T>() {
							const [kind, id] = values as [string, string];
							return (rows.get(key(kind, id)) ?? null) as T | null;
						}
					};
				}
			};
		}
	};
}

describe('memoryStore', () => {
	it('round-trips a frame', async () => {
		const store = memoryStore();
		await store.frames.put('abc', bytes('hello'));
		expect(new TextDecoder().decode((await store.frames.get('abc')) as Uint8Array)).toBe(
			'hello'
		);
	});

	it('answers null for a frame it does not hold', async () => {
		expect(await memoryStore().frames.get('missing')).toBeNull();
	});

	it('answers which of many hashes it holds in one call', async () => {
		const store = memoryStore();
		await store.frames.put('a', bytes('1'));
		await store.frames.put('c', bytes('3'));
		expect([...(await store.frames.has(['a', 'b', 'c']))].sort()).toEqual(['a', 'c']);
	});

	it('round-trips an index record and lists by prefix', async () => {
		const store = memoryStore();
		await store.index.put({ kind: 'worker', id: 'dev-a', data: { env: 'dev' } });
		await store.index.put({ kind: 'worker', id: 'prod-b', data: { env: 'prod' } });
		expect((await store.index.get('worker', 'dev-a'))?.data.env).toBe('dev');
		expect((await store.index.list('worker', { prefix: 'dev-' })).map((r) => r.id)).toEqual([
			'dev-a'
		]);
	});

	it('deletes', async () => {
		const store = memoryStore();
		await store.index.put({ kind: 'worker', id: 'x', data: {} });
		await store.index.delete('worker', 'x');
		expect(await store.index.get('worker', 'x')).toBeNull();
	});
});

describe('r2Frames', () => {
	it('keys frames under a prefix so a bucket can hold other things', async () => {
		const bucket = fakeR2();
		const frames = r2Frames(bucket);
		await frames.put('abc', bytes('x'));
		expect([...bucket.objects.keys()]).toEqual(['frames/abc']);
	});

	it('round-trips and reports presence', async () => {
		const frames = r2Frames(fakeR2());
		await frames.put('abc', bytes('x'));
		expect(await frames.get('abc')).not.toBeNull();
		expect([...(await frames.has(['abc', 'nope']))]).toEqual(['abc']);
	});
});

describe('kvIndex', () => {
	it('round-trips and lists', async () => {
		const index = kvIndex(fakeKv());
		await index.put({ kind: 'worker', id: 'a', data: { n: 1 } });
		expect((await index.get('worker', 'a'))?.data.n).toBe(1);
		expect((await index.list('worker')).map((r) => r.id)).toEqual(['a']);
	});
});

describe('d1Index', () => {
	it('round-trips, upserts and lists in id order', async () => {
		const index = d1Index(fakeD1());
		await index.migrate();
		await index.put({ kind: 'worker', id: 'b', data: { v: 1 } });
		await index.put({ kind: 'worker', id: 'a', data: { v: 2 } });
		await index.put({ kind: 'worker', id: 'b', data: { v: 3 } });
		expect((await index.get('worker', 'b'))?.data.v).toBe(3);
		expect((await index.list('worker')).map((r) => r.id)).toEqual(['a', 'b']);
	});

	it('deletes', async () => {
		const index = d1Index(fakeD1());
		await index.put({ kind: 'worker', id: 'a', data: {} });
		await index.delete('worker', 'a');
		expect(await index.get('worker', 'a')).toBeNull();
	});
});

describe('hybridStore', () => {
	it('puts frames in the object store and records in the database', async () => {
		const bucket = fakeR2();
		const store = hybridStore({ frames: r2Frames(bucket), index: d1Index(fakeD1()) });
		await store.frames.put('h', bytes('blob'));
		await store.index.put({ kind: 'worker', id: 'w', data: {} });
		expect([...bucket.objects.keys()]).toEqual(['frames/h']);
		expect(await store.index.get('worker', 'w')).not.toBeNull();
	});
});

describe('noStore', () => {
	it('refuses with a message naming what to do rather than pretending', async () => {
		await expect(noStore().frames.get('a')).rejects.toBeInstanceOf(UsageError);
		await expect(noStore().index.list('worker')).rejects.toThrow(/Pass `store` to workforce/);
	});
});
