/**
 * Checking a revision can still be rebuilt, before something needs it to be.
 *
 * strata runs drills that replay the store and diff the result against the live site, so a backup is
 * known to work before anyone depends on it. The cheap analogue here: rebuild a revision from its
 * frames and check the result still hashes to the manifest it was written with. A store that lost a
 * frame reports it now rather than during a revert.
 */

import type { Store } from '../store/index.js';
import { RevisionStore, revisionIdOf, type Revision } from './store.js';

export interface VerifyResult {
	revision: string;
	ok: boolean;
	/** frames the revision names that the store no longer holds */
	missingFrames: string[];
	/** files whose rebuilt bytes did not match the length recorded for them */
	corruptFiles: string[];
	/** set when the rebuilt manifest no longer produces the revision's own id */
	idMismatch: boolean;
}

export async function verifyRevision(
	store: Store,
	worker: string,
	id: string
): Promise<VerifyResult> {
	const revisions = new RevisionStore(store);
	const revision = await revisions.get(worker, id);
	const result: VerifyResult = {
		revision: id,
		ok: false,
		missingFrames: [],
		corruptFiles: [],
		idMismatch: false
	};
	if (revision === null) return result;

	const named = new Set(revision.files.flatMap((file) => file.frames));
	const held = await store.frames.has([...named]);
	result.missingFrames = [...named].filter((hash) => !held.has(hash));

	if (result.missingFrames.length === 0) {
		const rebuilt = await revisions.read(worker, id);
		for (const file of revision.files) {
			const bytes = rebuilt.get(file.path);
			if (bytes === undefined || bytes.byteLength !== file.bytes) {
				result.corruptFiles.push(file.path);
			}
		}
		result.idMismatch = (await revisionIdOf(revision.files)) !== revision.id;
	}

	result.ok =
		result.missingFrames.length === 0 && result.corruptFiles.length === 0 && !result.idMismatch;
	return result;
}

/** Verifies every revision a worker has, so a scheduled drill is one call. */
export async function verifyAll(store: Store, worker: string): Promise<VerifyResult[]> {
	const revisions = await new RevisionStore(store).list(worker, 1000);
	const out: VerifyResult[] = [];
	for (const revision of revisions) out.push(await verifyRevision(store, worker, revision.id));
	return out;
}

export function summariseVerification(results: readonly VerifyResult[]): {
	checked: number;
	ok: number;
	failed: string[];
} {
	const failed = results.filter((r) => !r.ok).map((r) => r.revision);
	return { checked: results.length, ok: results.length - failed.length, failed };
}

export type { Revision };
