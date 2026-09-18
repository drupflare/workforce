/**
 * Version history, because the platform will not give it back.
 *
 * `GET /scripts/{s}/versions/{v}` returns metadata, bindings and an `etag`, and no endpoint returns a
 * past version's modules. So a `revert` that reconstructs an old bundle, and a diff that shows what
 * changed, both need the content kept as it is uploaded. Pass a store and they work; pass none and
 * they say so instead.
 *
 * The model is `drupflare/worker/src/ops/module-rev.ts` plus strata's framing: content-addressed, an
 * immutable manifest per revision, and a revision id that is a digest over the sorted path-to-hash
 * lines, so the same file set uploaded twice is the same revision whatever order a client walked it.
 */

import { UsageError } from '../client/errors.js';
import { fromUtf8, toUtf8, type ModuleSet } from '../source.js';
import type { Store } from '../store/index.js';
import { codecFor, type CodecName } from './codec.js';
import { frame, hashFrame, unframe } from './frame.js';

/** `module-rev.ts`'s default, and its reason: enough to roll back through a bad afternoon */
export const REVISION_RETENTION = 5;

export interface FileRecord {
	path: string;
	/** the frame hashes this file is made of, in order */
	frames: string[];
	bytes: number;
}

export interface Revision {
	/** a digest over the sorted `path hash` lines, so identical content is one revision */
	id: string;
	worker: string;
	createdAtMs: number;
	/** the plane's version id, when the upload produced one */
	versionId: string | null;
	/** the plane's own content hash, which is how a version workforce did not make is spotted */
	etag: string | null;
	codec: CodecName;
	files: FileRecord[];
	label: string | null;
	/** the revision this one was built on, so `log()` walks without a second store */
	parent: string | null;
}

export interface WriteOptions {
	versionId?: string | null;
	etag?: string | null;
	label?: string;
	parent?: string | null;
	codec?: CodecName;
	frameBytes?: number;
	now?: () => number;
}

/** the id a file set has, whatever order it was walked in */
export async function revisionIdOf(files: readonly FileRecord[]): Promise<string> {
	const lines = [...files]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file) => `${file.path} ${file.frames.join(',')}`)
		.join('\n');
	return hashFrame(fromUtf8(lines));
}

export class RevisionStore {
	constructor(private readonly store: Store) {}

	private recordKind(worker: string): string {
		return `revision:${worker}`;
	}

	/**
	 * Frames, compresses and writes what is not already held.
	 *
	 * Presence is asked once for every frame rather than once per frame, because dedup exists to
	 * skip writes, and a round trip each would spend what it saved.
	 */
	async write(
		worker: string,
		modules: ModuleSet,
		options: WriteOptions = {}
	): Promise<{ revision: Revision; wrote: number; reused: number }> {
		const codecName = options.codec ?? 'none';
		const codec = codecFor(codecName);
		const now = options.now ?? (() => Date.now());

		const files: FileRecord[] = [];
		const pending = new Map<string, Uint8Array>();
		for (const [path, bytes] of modules) {
			const framed = await frame(bytes, options.frameBytes);
			for (const part of framed) {
				if (!pending.has(part.hash)) pending.set(part.hash, part.bytes);
			}
			files.push({
				path,
				frames: framed.map((f) => f.hash),
				bytes: bytes.byteLength
			});
		}

		const hashes = [...pending.keys()];
		const held = await this.store.frames.has(hashes);
		let wrote = 0;
		for (const [hash, bytes] of pending) {
			if (held.has(hash)) continue;
			await this.store.frames.put(hash, await codec.encode(bytes));
			wrote += 1;
		}

		const revision: Revision = {
			id: await revisionIdOf(files),
			worker,
			createdAtMs: now(),
			versionId: options.versionId ?? null,
			etag: options.etag ?? null,
			codec: codecName,
			files,
			label: options.label ?? null,
			parent: options.parent ?? null
		};

		await this.store.index.put({
			kind: this.recordKind(worker),
			id: revision.id,
			data: revision as unknown as Record<string, unknown>,
			updatedAtMs: revision.createdAtMs
		});

		return { revision, wrote, reused: hashes.length - wrote };
	}

	async get(worker: string, id: string): Promise<Revision | null> {
		const record = await this.store.index.get(this.recordKind(worker), id);
		return record === null ? null : (record.data as unknown as Revision);
	}

	/** newest first, which is the order every caller wants */
	async list(worker: string, limit = 50): Promise<Revision[]> {
		const records = await this.store.index.list(this.recordKind(worker), { limit: 1000 });
		return records
			.map((r) => r.data as unknown as Revision)
			.sort((a, b) => b.createdAtMs - a.createdAtMs)
			.slice(0, limit);
	}

	/** the revision a plane version id came from, or null when workforce did not make it */
	async byVersion(worker: string, versionId: string): Promise<Revision | null> {
		return (await this.list(worker, 1000)).find((r) => r.versionId === versionId) ?? null;
	}

	/**
	 * Rebuilds the module set a revision recorded.
	 *
	 * Refuses on a missing frame rather than returning a partial bundle: half a Worker that deploys is
	 * worse than a refusal that names what is gone.
	 */
	async read(worker: string, id: string): Promise<ModuleSet> {
		const revision = await this.get(worker, id);
		if (revision === null) {
			throw new UsageError(`no revision ${id} for ${worker}`);
		}
		const codec = codecFor(revision.codec);
		const modules: ModuleSet = new Map();
		for (const file of revision.files) {
			const parts: Uint8Array[] = [];
			for (const hash of file.frames) {
				const stored = await this.store.frames.get(hash);
				if (stored === null) {
					throw new UsageError(
						`revision ${id} names frame ${hash} for ${file.path}, and the store no longer holds it`
					);
				}
				parts.push(await codec.decode(stored));
			}
			modules.set(file.path, unframe(parts));
		}
		return modules;
	}

	/** every frame hash any surviving revision still names */
	async reachable(worker: string): Promise<Set<string>> {
		const out = new Set<string>();
		for (const revision of await this.list(worker, 1000)) {
			for (const file of revision.files) for (const hash of file.frames) out.add(hash);
		}
		return out;
	}
}

/** whether a plane version was produced by something other than workforce */
export function isForeignVersion(revision: Revision | null, etag: string | null): boolean {
	if (revision === null) return true;
	if (etag === null || revision.etag === null) return false;
	return revision.etag !== etag;
}

/** @internal decodes a stored text frame, used by the diff when it renders a file */
export function frameText(bytes: Uint8Array): string {
	return toUtf8(bytes);
}
