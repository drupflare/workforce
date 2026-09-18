/**
 * Pruning, with a receipt.
 *
 * Dropping a revision frees only the frames no surviving revision still names, which is a reachability
 * question rather than a per-revision one. `module-rev.ts` states the same rule for its blobs. The
 * receipt exists because a prune that reports nothing is indistinguishable from a prune that did
 * nothing, and both look fine in a log.
 */

import type { Store } from '../store/index.js';
import { REVISION_RETENTION, RevisionStore, type Revision } from './store.js';

export interface PruneReceipt {
	worker: string;
	kept: string[];
	dropped: string[];
	framesFreed: number;
	framesKept: number;
}

export interface PruneOptions {
	retain?: number;
	/** report what would happen without touching anything */
	dryRun?: boolean;
}

/** which revisions a retention policy keeps, newest first */
export function planRetention(
	revisions: readonly Revision[],
	retain = REVISION_RETENTION
): { kept: Revision[]; dropped: Revision[] } {
	const ordered = [...revisions].sort((a, b) => b.createdAtMs - a.createdAtMs);
	return { kept: ordered.slice(0, retain), dropped: ordered.slice(retain) };
}

/** every frame the kept revisions still name */
export function reachableFrames(revisions: readonly Revision[]): Set<string> {
	const out = new Set<string>();
	for (const revision of revisions) {
		for (const file of revision.files) for (const hash of file.frames) out.add(hash);
	}
	return out;
}

export async function prune(
	store: Store,
	worker: string,
	options: PruneOptions = {}
): Promise<PruneReceipt> {
	const revisions = new RevisionStore(store);
	const all = await revisions.list(worker, 1000);
	const { kept, dropped } = planRetention(all, options.retain);

	const keptFrames = reachableFrames(kept);
	const droppedFrames = reachableFrames(dropped);
	// a frame a surviving revision still names is not garbage, whichever revision wrote it
	const freeable = [...droppedFrames].filter((hash) => !keptFrames.has(hash));

	if (options.dryRun !== true) {
		for (const revision of dropped) {
			await store.index.delete(`revision:${worker}`, revision.id);
		}
		for (const hash of freeable) await store.frames.delete(hash);
	}

	return {
		worker,
		kept: kept.map((r) => r.id),
		dropped: dropped.map((r) => r.id),
		framesFreed: freeable.length,
		framesKept: keptFrames.size
	};
}
