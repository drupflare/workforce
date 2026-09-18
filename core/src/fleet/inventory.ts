/**
 * What exists, and how it is labelled.
 *
 * The default inventory is the plane itself: list the workers, read their tags. That works with zero
 * setup, which is what keeps this a library rather than something you provision before first use.
 *
 * **Tags cannot carry the whole model and that is a finding rather than an inconvenience.** Workers
 * for Platforms caps at eight per script, and a fleet wants environment, owner, kind, cms, plane, pr,
 * ttl, last-seen, source and revision, which is ten. So tags carry only what has to be readable
 * without a store and the store carries the rest.
 */

import { UsageError } from '../client/errors.js';
import type { Plane, WorkerSummary } from '../plane/plane.js';
import type { Store } from '../store/index.js';

/** the tag keys this library writes; the cap is eight and these are four */
export const TAG_KEYS = ['wf:env', 'wf:owner', 'wf:ttl', 'wf:rev'] as const;
export type TagKey = (typeof TAG_KEYS)[number];

/** Workers for Platforms allows eight tags per script, and nothing here may exceed it */
export const MAX_TAGS = 8;

export interface InventoryRecord {
	worker: string;
	plane: string;
	env: string | null;
	owner: string | null;
	/** milliseconds since the epoch, after which a sweep may remove this worker */
	ttlAtMs: number | null;
	revision: string | null;
	/** anything a consumer wants that will not fit in the tag budget */
	extra: Record<string, unknown>;
	lastSeenMs: number | null;
}

export function encodeTags(record: Partial<InventoryRecord>): string[] {
	const tags: string[] = [];
	if (record.env != null) tags.push(`wf:env=${record.env}`);
	if (record.owner != null) tags.push(`wf:owner=${record.owner}`);
	if (record.ttlAtMs != null) tags.push(`wf:ttl=${record.ttlAtMs}`);
	if (record.revision != null) tags.push(`wf:rev=${record.revision}`);
	if (tags.length > MAX_TAGS) {
		throw new UsageError(
			`${tags.length} tags is past the ${MAX_TAGS} a script may carry; put the rest in the store`
		);
	}
	return tags;
}

export function decodeTags(tags: readonly string[]): Partial<InventoryRecord> {
	const out: Partial<InventoryRecord> = {};
	for (const tag of tags) {
		const at = tag.indexOf('=');
		if (at === -1) continue;
		const key = tag.slice(0, at);
		const value = tag.slice(at + 1);
		if (key === 'wf:env') out.env = value;
		if (key === 'wf:owner') out.owner = value;
		if (key === 'wf:rev') out.revision = value;
		if (key === 'wf:ttl') {
			const parsed = Number(value);
			out.ttlAtMs = Number.isFinite(parsed) ? parsed : null;
		}
	}
	return out;
}

export interface InventoryStore {
	list(): Promise<InventoryRecord[]>;
	get(worker: string): Promise<InventoryRecord | null>;
	put(record: InventoryRecord): Promise<void>;
	delete(worker: string): Promise<void>;
}

/** the store-backed inventory, for a consumer that outgrows four tags */
export function storeInventory(store: Store, plane: string): InventoryStore {
	const kind = `inventory:${plane}`;
	return {
		async list() {
			const records = await store.index.list(kind, { limit: 10_000 });
			return records.map((r) => r.data as unknown as InventoryRecord);
		},
		async get(worker) {
			const record = await store.index.get(kind, worker);
			return record === null ? null : (record.data as unknown as InventoryRecord);
		},
		async put(record) {
			await store.index.put({
				kind,
				id: record.worker,
				data: record as unknown as Record<string, unknown>
			});
		},
		async delete(worker) {
			await store.index.delete(kind, worker);
		}
	};
}

/**
 * The inventory derived from the plane itself.
 *
 * Reads a listing and its tags, so it needs nothing provisioned. It cannot hold more than the tag
 * budget, which is exactly why `storeInventory` exists beside it.
 */
export function planeInventory(plane: Plane): InventoryStore {
	const recordOf = (summary: WorkerSummary): InventoryRecord => ({
		worker: summary.name,
		plane: plane.kind,
		env: null,
		owner: null,
		ttlAtMs: null,
		revision: null,
		extra: {},
		lastSeenMs: null,
		...decodeTags(summary.tags)
	});

	return {
		async list() {
			return (await plane.list()).map(recordOf);
		},
		async get(worker) {
			const summary = await plane.get(worker);
			return summary === null ? null : recordOf(summary);
		},
		async put(record) {
			await plane.setTags(record.worker, encodeTags(record));
		},
		async delete() {
			// the plane IS the inventory here: deleting a record would mean deleting the worker, and
			// this call is about bookkeeping rather than about destroying anything
			throw new UsageError(
				'a plane-backed inventory cannot forget a worker that still exists; delete the worker, or use a store-backed inventory'
			);
		}
	};
}

export interface FleetFilter {
	env?: string;
	owner?: string;
	/** a predicate for anything the four tags do not cover */
	where?: (record: InventoryRecord) => boolean;
}

export function matches(record: InventoryRecord, filter: FleetFilter): boolean {
	if (filter.env !== undefined && record.env !== filter.env) return false;
	if (filter.owner !== undefined && record.owner !== filter.owner) return false;
	if (filter.where !== undefined && !filter.where(record)) return false;
	return true;
}

/** records whose ttl has passed, which is what a sweep acts on */
export function expired(records: readonly InventoryRecord[], nowMs: number): InventoryRecord[] {
	return records.filter((r) => r.ttlAtMs !== null && r.ttlAtMs <= nowMs);
}
