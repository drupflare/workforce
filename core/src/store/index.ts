/**
 * Where workforce keeps its own state, as a provider you hand in.
 *
 * Two shapes, and they want different homes. **Frames** are immutable binary blobs fetched by digest,
 * there are potentially millions, and nothing ever queries them by anything but their hash: that is
 * an object store. The **index** is one small record per worker, queried by tag and environment: that
 * is a database, and a tiny one. `hybridStore` composes the two.
 *
 * Nothing here provisions anything. A binding is passed in, and a caller with no store at all still
 * gets a working library with the history features reporting themselves unavailable.
 */

import { UsageError } from '../client/errors.js';

/** a record the index holds, keyed by `kind` and `id` */
export interface StoreRecord {
	kind: string;
	id: string;
	data: Record<string, unknown>;
	updatedAtMs: number;
}

export interface IndexStore {
	get(kind: string, id: string): Promise<StoreRecord | null>;
	put(record: Omit<StoreRecord, 'updatedAtMs'> & { updatedAtMs?: number }): Promise<void>;
	delete(kind: string, id: string): Promise<void>;
	list(kind: string, options?: { prefix?: string; limit?: number }): Promise<StoreRecord[]>;
}

export interface FrameStore {
	put(hash: string, bytes: Uint8Array): Promise<void>;
	get(hash: string): Promise<Uint8Array | null>;
	/** one call for many hashes; asking one at a time spends the budget dedup exists to save */
	has(hashes: readonly string[]): Promise<Set<string>>;
	delete(hash: string): Promise<void>;
}

export interface Store {
	readonly frames: FrameStore;
	readonly index: IndexStore;
}

export function memoryStore(): Store {
	const frames = new Map<string, Uint8Array>();
	const records = new Map<string, StoreRecord>();
	const key = (kind: string, id: string): string => `${kind} ${id}`;

	return {
		frames: {
			async put(hash, bytes) {
				frames.set(hash, bytes);
			},
			async get(hash) {
				return frames.get(hash) ?? null;
			},
			async has(hashes) {
				return new Set(hashes.filter((hash) => frames.has(hash)));
			},
			async delete(hash) {
				frames.delete(hash);
			}
		},
		index: {
			async get(kind, id) {
				return records.get(key(kind, id)) ?? null;
			},
			async put(record) {
				records.set(key(record.kind, record.id), {
					...record,
					updatedAtMs: record.updatedAtMs ?? Date.now()
				});
			},
			async delete(kind, id) {
				records.delete(key(kind, id));
			},
			async list(kind, options = {}) {
				const out = [...records.values()].filter(
					(r) =>
						r.kind === kind &&
						(options.prefix === undefined || r.id.startsWith(options.prefix))
				);
				return options.limit === undefined ? out : out.slice(0, options.limit);
			}
		}
	};
}

/** the slice of `R2Bucket` this uses, so the package does not depend on the full binding type */
export interface R2Like {
	put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	head(key: string): Promise<unknown | null>;
	delete(key: string): Promise<void>;
}

export interface KVLike {
	put(key: string, value: string): Promise<void>;
	get(key: string, type?: 'text'): Promise<string | null>;
	delete(key: string): Promise<void>;
	list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

export interface D1Like {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<unknown>;
			all<T = unknown>(): Promise<{ results: T[] }>;
			first<T = unknown>(): Promise<T | null>;
		};
	};
}

const FRAME_PREFIX = 'frames/';

export function r2Frames(bucket: R2Like): FrameStore {
	return {
		async put(hash, bytes) {
			await bucket.put(`${FRAME_PREFIX}${hash}`, bytes);
		},
		async get(hash) {
			const object = await bucket.get(`${FRAME_PREFIX}${hash}`);
			return object === null ? null : new Uint8Array(await object.arrayBuffer());
		},
		async has(hashes) {
			const found = new Set<string>();
			// R2 has no batch head, so this is N round trips; the caller's dedup still saves the far
			// more expensive N writes
			await Promise.all(
				hashes.map(async (hash) => {
					if ((await bucket.head(`${FRAME_PREFIX}${hash}`)) !== null) found.add(hash);
				})
			);
			return found;
		},
		async delete(hash) {
			await bucket.delete(`${FRAME_PREFIX}${hash}`);
		}
	};
}

export function kvIndex(namespace: KVLike): IndexStore {
	const key = (kind: string, id: string): string => `idx/${kind}/${id}`;
	return {
		async get(kind, id) {
			const raw = await namespace.get(key(kind, id));
			return raw === null ? null : (JSON.parse(raw) as StoreRecord);
		},
		async put(record) {
			await namespace.put(
				key(record.kind, record.id),
				JSON.stringify({ ...record, updatedAtMs: record.updatedAtMs ?? Date.now() })
			);
		},
		async delete(kind, id) {
			await namespace.delete(key(kind, id));
		},
		async list(kind, options = {}) {
			const listed = await namespace.list({
				prefix: `idx/${kind}/${options.prefix ?? ''}`,
				limit: options.limit
			});
			const out: StoreRecord[] = [];
			for (const entry of listed.keys) {
				const raw = await namespace.get(entry.name);
				if (raw !== null) out.push(JSON.parse(raw) as StoreRecord);
			}
			return out;
		}
	};
}

export const D1_INDEX_DDL =
	'CREATE TABLE IF NOT EXISTS workforce_index (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (kind, id))';

const D1_UPSERT =
	'INSERT INTO workforce_index (kind, id, data, updated_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, updated_at_ms = excluded.updated_at_ms';

const D1_LIST =
	'SELECT kind, id, data, updated_at_ms FROM workforce_index WHERE kind = ? AND id LIKE ? ORDER BY id LIMIT ?';

const D1_GET =
	'SELECT kind, id, data, updated_at_ms FROM workforce_index WHERE kind = ? AND id = ?';

interface IndexRow {
	kind: string;
	id: string;
	data: string;
	updated_at_ms: number;
}

/**
 * The index in one D1 database, and one is always enough.
 *
 * A record is on the order of hundreds of bytes against D1's 10 GB per database, so this does not
 * shard and does not need to. The large data is frames, which are not here.
 */
export function d1Index(db: D1Like): IndexStore & { migrate(): Promise<void> } {
	const rowOf = (row: IndexRow): StoreRecord => ({
		kind: row.kind,
		id: row.id,
		data: JSON.parse(row.data) as Record<string, unknown>,
		updatedAtMs: row.updated_at_ms
	});

	return {
		async migrate() {
			await db.prepare(D1_INDEX_DDL).bind().run();
		},
		async get(kind, id) {
			const row = await db.prepare(D1_GET).bind(kind, id).first<IndexRow>();
			return row === null ? null : rowOf(row);
		},
		async put(record) {
			await db
				.prepare(D1_UPSERT)
				.bind(
					record.kind,
					record.id,
					JSON.stringify(record.data),
					record.updatedAtMs ?? Date.now()
				)
				.run();
		},
		async delete(kind, id) {
			await db
				.prepare('DELETE FROM workforce_index WHERE kind = ? AND id = ?')
				.bind(kind, id)
				.run();
		},
		async list(kind, options = {}) {
			const { results } = await db
				.prepare(D1_LIST)
				.bind(kind, `${options.prefix ?? ''}%`, options.limit ?? 1000)
				.all<IndexRow>();
			return results.map(rowOf);
		}
	};
}

export interface HybridInput {
	frames: FrameStore;
	index: IndexStore;
}

/** Composes an object store for frames with a database for the index. */
export function hybridStore(input: HybridInput): Store {
	return { frames: input.frames, index: input.index };
}

export function r2Store(bucket: R2Like, index: IndexStore): Store {
	return hybridStore({ frames: r2Frames(bucket), index });
}

export function d1Store(db: D1Like, frames: FrameStore): Store {
	return hybridStore({ frames, index: d1Index(db) });
}

export function kvStore(namespace: KVLike, frames: FrameStore): Store {
	return hybridStore({ frames, index: kvIndex(namespace) });
}

/** a store that refuses rather than pretending, for a caller who configured none */
export function noStore(): Store {
	// async, not a bare throw: these are declared to return promises, and a synchronous throw from
	// one breaks a caller who wrote .catch() instead of try/catch
	const refuse = async (): Promise<never> => {
		throw new UsageError(
			'no store is configured, so there is nowhere to keep this. Pass `store` to workforce() to turn version history on.'
		);
	};
	return {
		frames: { put: refuse, get: refuse, has: refuse, delete: refuse },
		index: { get: refuse, put: refuse, delete: refuse, list: refuse }
	};
}
