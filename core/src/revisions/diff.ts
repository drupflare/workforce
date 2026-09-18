/**
 * What changed between two points.
 *
 * Compares module bytes, bindings, runtime settings, routes and tags, and secret NAMES but never
 * values, because the API does not return them. Where one side is a version workforce has no content
 * for, it reports the metadata comparison and says the content half was unavailable rather than
 * implying the files are identical.
 */

import { toUtf8, type ModuleSet } from '../source.js';
import { diffBindings, type Binding, type BindingDiff } from '../worker/bindings.js';

export type FileChange = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FileDiff {
	path: string;
	change: FileChange;
	beforeBytes: number | null;
	afterBytes: number | null;
	/** absent for binary files, where a line diff would be noise */
	lines?: LineChange[];
}

export interface LineChange {
	kind: 'add' | 'remove' | 'context';
	text: string;
}

export interface WorkerDiff {
	files: FileDiff[];
	bindings: BindingDiff;
	compatibilityDate: { before: string | null; after: string | null } | null;
	compatibilityFlags: { added: string[]; removed: string[] };
	tags: { added: string[]; removed: string[] };
	secretNames: { added: string[]; removed: string[] };
	/** set when one side had no stored content, so the file comparison could not run */
	contentUnavailable: 'before' | 'after' | 'both' | null;
}

const TEXT = /^[\s\S]*$/;

/** whether these bytes look like text worth diffing line by line */
export function isTextual(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8000);
	for (const byte of sample) {
		// a NUL byte is the cheap and reliable separator between text and a compiled artifact
		if (byte === 0) return false;
	}
	return TEXT.test('');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let at = 0; at < a.byteLength; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

/**
 * A line diff, longest-common-subsequence over lines.
 *
 * Small on purpose. A Worker bundle is usually one minified line, so the value here is in the
 * hand-written sources a caller also ships, and a full Myers implementation would be a dependency for
 * a case this shape does not reward.
 */
export function diffLines(before: string, after: string): LineChange[] {
	const a = before.split('\n');
	const b = after.split('\n');
	const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			const row = lengths[i] as number[];
			const next = lengths[i + 1] as number[];
			row[j] =
				a[i] === b[j]
					? (next[j + 1] as number) + 1
					: Math.max(next[j] as number, row[j + 1] as number);
		}
	}

	const out: LineChange[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ kind: 'context', text: a[i] as string });
			i += 1;
			j += 1;
			continue;
		}
		const down = (lengths[i + 1] as number[])[j] as number;
		const right = (lengths[i] as number[])[j + 1] as number;
		if (down >= right) {
			out.push({ kind: 'remove', text: a[i] as string });
			i += 1;
		} else {
			out.push({ kind: 'add', text: b[j] as string });
			j += 1;
		}
	}
	while (i < a.length) {
		out.push({ kind: 'remove', text: a[i] as string });
		i += 1;
	}
	while (j < b.length) {
		out.push({ kind: 'add', text: b[j] as string });
		j += 1;
	}
	return out;
}

export function diffModules(before: ModuleSet, after: ModuleSet): FileDiff[] {
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	return paths.map((path) => {
		const a = before.get(path);
		const b = after.get(path);
		if (a === undefined) {
			return { path, change: 'added', beforeBytes: null, afterBytes: b?.byteLength ?? 0 };
		}
		if (b === undefined) {
			return { path, change: 'removed', beforeBytes: a.byteLength, afterBytes: null };
		}
		if (sameBytes(a, b)) {
			return {
				path,
				change: 'unchanged',
				beforeBytes: a.byteLength,
				afterBytes: b.byteLength
			};
		}
		const diff: FileDiff = {
			path,
			change: 'changed',
			beforeBytes: a.byteLength,
			afterBytes: b.byteLength
		};
		if (isTextual(a) && isTextual(b)) diff.lines = diffLines(toUtf8(a), toUtf8(b));
		return diff;
	});
}

export interface DiffSide {
	modules: ModuleSet | null;
	bindings: Binding[];
	compatibilityDate: string | null;
	compatibilityFlags: string[];
	tags: string[];
	secretNames: string[];
}

function setDiff(before: readonly string[], after: readonly string[]) {
	const had = new Set(before);
	const has = new Set(after);
	return {
		added: after.filter((v) => !had.has(v)).sort(),
		removed: before.filter((v) => !has.has(v)).sort()
	};
}

export function diffWorkers(before: DiffSide, after: DiffSide): WorkerDiff {
	const missing =
		before.modules === null && after.modules === null
			? 'both'
			: before.modules === null
				? 'before'
				: after.modules === null
					? 'after'
					: null;

	return {
		files:
			before.modules !== null && after.modules !== null
				? diffModules(before.modules, after.modules)
				: [],
		bindings: diffBindings(before.bindings, after.bindings),
		compatibilityDate:
			before.compatibilityDate === after.compatibilityDate
				? null
				: { before: before.compatibilityDate, after: after.compatibilityDate },
		compatibilityFlags: setDiff(before.compatibilityFlags, after.compatibilityFlags),
		tags: setDiff(before.tags, after.tags),
		secretNames: setDiff(before.secretNames, after.secretNames),
		contentUnavailable: missing
	};
}

/** whether anything at all differs, which is what a caller deciding to deploy wants */
export function hasChanges(diff: WorkerDiff): boolean {
	if (diff.files.some((f) => f.change !== 'unchanged')) return true;
	if (
		diff.bindings.added.length + diff.bindings.changed.length + diff.bindings.removed.length >
		0
	) {
		return true;
	}
	if (diff.compatibilityDate !== null) return true;
	const lists = [diff.compatibilityFlags, diff.tags, diff.secretNames];
	return lists.some((l) => l.added.length + l.removed.length > 0);
}
