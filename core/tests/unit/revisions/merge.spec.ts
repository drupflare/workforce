import { describe, expect, it } from 'vitest';
import { merge, mergeText } from '../../../src/revisions/merge.js';
import { fromFiles, toUtf8 } from '../../../src/source.js';

const text = (set: ReturnType<typeof fromFiles>, path: string): string =>
	toUtf8(set.get(path) as Uint8Array);

describe('mergeText', () => {
	it('takes a change from each side when they touched different lines', () => {
		const merged = mergeText('a\nb\nc', 'A\nb\nc', 'a\nb\nC');
		expect(merged.conflict).toBe(false);
		expect(merged.text).toBe('A\nb\nC');
	});

	it('marks a conflict when both sides changed the same line', () => {
		const merged = mergeText('a\nb\nc', 'a\nOURS\nc', 'a\nTHEIRS\nc');
		expect(merged.conflict).toBe(true);
		expect(merged.text).toContain('<<<<<<< ours');
		expect(merged.text).toContain('>>>>>>> theirs');
	});
});

describe('merge', () => {
	const base = fromFiles({ 'a.js': 'one\ntwo\nthree', 'shared.js': 'unchanged' });

	it('leaves a file neither side touched alone', () => {
		const result = merge(base, base, base);
		expect(result.clean).toBe(true);
		expect(result.files.every((f) => f.outcome === 'unchanged')).toBe(true);
	});

	it('takes our change when only we touched it', () => {
		const ours = fromFiles({ 'a.js': 'ONE\ntwo\nthree', 'shared.js': 'unchanged' });
		const result = merge(base, ours, base);
		expect(result.clean).toBe(true);
		expect(text(result.modules, 'a.js')).toBe('ONE\ntwo\nthree');
	});

	it('takes their change when only they touched it', () => {
		const theirs = fromFiles({ 'a.js': 'one\ntwo\nTHREE', 'shared.js': 'unchanged' });
		const result = merge(base, base, theirs);
		expect(text(result.modules, 'a.js')).toBe('one\ntwo\nTHREE');
	});

	it('merges two changes to different lines of one file', () => {
		const ours = fromFiles({ 'a.js': 'ONE\ntwo\nthree', 'shared.js': 'unchanged' });
		const theirs = fromFiles({ 'a.js': 'one\ntwo\nTHREE', 'shared.js': 'unchanged' });
		const result = merge(base, ours, theirs);
		expect(result.clean).toBe(true);
		expect(text(result.modules, 'a.js')).toBe('ONE\ntwo\nTHREE');
	});

	it('conflicts when both sides changed the same line', () => {
		const ours = fromFiles({ 'a.js': 'one\nOURS\nthree', 'shared.js': 'unchanged' });
		const theirs = fromFiles({ 'a.js': 'one\nTHEIRS\nthree', 'shared.js': 'unchanged' });
		const result = merge(base, ours, theirs);
		expect(result.clean).toBe(false);
		expect(result.conflicts.map((c) => c.path)).toEqual(['a.js']);
	});

	it('conflicts on a binary both sides changed rather than picking one', () => {
		const binBase = fromFiles({ 'x.wasm': new Uint8Array([0, 1, 2]) });
		const ours = fromFiles({ 'x.wasm': new Uint8Array([0, 1, 9]) });
		const theirs = fromFiles({ 'x.wasm': new Uint8Array([0, 1, 7]) });
		const result = merge(binBase, ours, theirs);
		expect(result.conflicts[0]?.reason).toMatch(/binary/);
	});

	it('takes an identical change from both sides without calling it a conflict', () => {
		const same = fromFiles({ 'a.js': 'BOTH\ntwo\nthree', 'shared.js': 'unchanged' });
		const result = merge(base, same, same);
		expect(result.clean).toBe(true);
		expect(text(result.modules, 'a.js')).toBe('BOTH\ntwo\nthree');
	});

	it('conflicts when one side deleted what the other changed', () => {
		const ours = fromFiles({ 'shared.js': 'unchanged' });
		const theirs = fromFiles({ 'a.js': 'changed\ntwo\nthree', 'shared.js': 'unchanged' });
		const result = merge(base, ours, theirs);
		expect(result.conflicts[0]?.reason).toMatch(/deleted/);
	});

	it('drops a file both sides deleted', () => {
		const without = fromFiles({ 'shared.js': 'unchanged' });
		const result = merge(base, without, without);
		expect(result.modules.has('a.js')).toBe(false);
		expect(result.clean).toBe(true);
	});

	it('conflicts when both sides added the same path with different content', () => {
		const ours = fromFiles({ ...Object.fromEntries(base), 'new.js': 'ours' });
		const theirs = fromFiles({ ...Object.fromEntries(base), 'new.js': 'theirs' });
		const result = merge(base, ours, theirs);
		expect(result.conflicts.map((c) => c.path)).toEqual(['new.js']);
		expect(result.conflicts[0]?.reason).toMatch(/no base/);
	});
});
