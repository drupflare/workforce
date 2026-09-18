/**
 * Three-way merge of module sets.
 *
 * Its own subpath (`@drupflare/workforce/merge`) so a Worker that never merges does not carry the
 * algorithm. Text files merge line by line; a binary file that differs on both sides is a conflict
 * rather than a guess, because picking a side of two compiled artifacts is how a merge produces
 * something that builds and is wrong.
 */

import { diff3Merge } from 'node-diff3';
import { fromUtf8, toUtf8, type ModuleSet } from '../source.js';
import { isTextual } from './diff.js';

export type MergeOutcome = 'unchanged' | 'ours' | 'theirs' | 'merged' | 'conflict' | 'deleted';

export interface FileMerge {
	path: string;
	outcome: MergeOutcome;
	/** why a conflict is a conflict, for a caller that has to explain it */
	reason?: string;
}

export interface MergeResult {
	modules: ModuleSet;
	files: FileMerge[];
	conflicts: FileMerge[];
	get clean(): boolean;
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.byteLength !== b.byteLength) return false;
	for (let at = 0; at < a.byteLength; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

interface MergedText {
	text: string | null;
	conflict: boolean;
}

/** diff3 over lines, rendered back with conflict markers when both sides touched one */
export function mergeText(base: string, ours: string, theirs: string): MergedText {
	const regions = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'));
	const out: string[] = [];
	let conflict = false;

	for (const region of regions) {
		if ('ok' in region && region.ok !== undefined) {
			out.push(...region.ok);
			continue;
		}
		const parts = (region as { conflict?: { a: string[]; o: string[]; b: string[] } }).conflict;
		if (parts === undefined) continue;
		conflict = true;
		out.push('<<<<<<< ours', ...parts.a, '=======', ...parts.b, '>>>>>>> theirs');
	}

	return { text: out.join('\n'), conflict };
}

/**
 * Merges `ours` and `theirs` against their common `base`.
 *
 * A side that did not touch a file loses to the side that did, which is the ordinary three-way rule.
 * Both touching one differently is a merge for text and a conflict for anything else.
 */
export function merge(base: ModuleSet, ours: ModuleSet, theirs: ModuleSet): MergeResult {
	const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();
	const modules: ModuleSet = new Map();
	const files: FileMerge[] = [];

	for (const path of paths) {
		const b = base.get(path);
		const o = ours.get(path);
		const t = theirs.get(path);

		const oursChanged = !sameBytes(b, o);
		const theirsChanged = !sameBytes(b, t);

		if (!oursChanged && !theirsChanged) {
			if (o !== undefined) modules.set(path, o);
			files.push({ path, outcome: 'unchanged' });
			continue;
		}
		if (oursChanged && !theirsChanged) {
			if (o === undefined) {
				files.push({ path, outcome: 'deleted' });
			} else {
				modules.set(path, o);
				files.push({ path, outcome: 'ours' });
			}
			continue;
		}
		if (!oursChanged && theirsChanged) {
			if (t === undefined) {
				files.push({ path, outcome: 'deleted' });
			} else {
				modules.set(path, t);
				files.push({ path, outcome: 'theirs' });
			}
			continue;
		}

		// both sides moved it
		if (sameBytes(o, t)) {
			if (o !== undefined) modules.set(path, o);
			files.push({ path, outcome: 'merged' });
			continue;
		}
		if (o === undefined || t === undefined) {
			files.push({
				path,
				outcome: 'conflict',
				reason: 'one side deleted it and the other changed it'
			});
			if (o !== undefined) modules.set(path, o);
			if (t !== undefined) modules.set(path, t);
			continue;
		}
		if (b === undefined) {
			files.push({
				path,
				outcome: 'conflict',
				reason: 'both sides added it with different content and there is no base to merge against'
			});
			modules.set(path, o);
			continue;
		}
		if (!isTextual(b) || !isTextual(o) || !isTextual(t)) {
			files.push({
				path,
				outcome: 'conflict',
				reason: 'binary, and both sides changed it; picking one would be a guess'
			});
			modules.set(path, o);
			continue;
		}

		const merged = mergeText(toUtf8(b), toUtf8(o), toUtf8(t));
		modules.set(path, fromUtf8(merged.text ?? toUtf8(o)));
		files.push(
			merged.conflict
				? { path, outcome: 'conflict', reason: 'both sides changed the same lines' }
				: { path, outcome: 'merged' }
		);
	}

	const conflicts = files.filter((f) => f.outcome === 'conflict');
	return {
		modules,
		files,
		conflicts,
		get clean() {
			return conflicts.length === 0;
		}
	};
}
