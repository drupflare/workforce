import { describe, expect, it } from 'vitest';
import {
	diffLines,
	diffModules,
	diffWorkers,
	hasChanges,
	isTextual,
	type DiffSide
} from '../../../src/revisions/diff.js';
import { fromFiles } from '../../../src/source.js';

const side = (over: Partial<DiffSide> = {}): DiffSide => ({
	modules: fromFiles({}),
	bindings: [],
	compatibilityDate: null,
	compatibilityFlags: [],
	tags: [],
	secretNames: [],
	...over
});

describe('isTextual', () => {
	it('reads text as text and a NUL-bearing blob as binary', () => {
		expect(isTextual(new TextEncoder().encode('hello\nworld'))).toBe(true);
		expect(isTextual(new Uint8Array([0x48, 0x00, 0x49]))).toBe(false);
	});
});

describe('diffLines', () => {
	it('reports an added line', () => {
		const changes = diffLines('a\nb', 'a\nb\nc');
		expect(changes.filter((c) => c.kind === 'add').map((c) => c.text)).toEqual(['c']);
	});

	it('reports a removed line', () => {
		const changes = diffLines('a\nb\nc', 'a\nc');
		expect(changes.filter((c) => c.kind === 'remove').map((c) => c.text)).toEqual(['b']);
	});

	it('reports a changed line as a remove and an add', () => {
		const changes = diffLines('one', 'two');
		expect(changes.map((c) => c.kind).sort()).toEqual(['add', 'remove']);
	});

	it('is all context for identical text', () => {
		expect(diffLines('same\nlines', 'same\nlines').every((c) => c.kind === 'context')).toBe(
			true
		);
	});
});

describe('diffModules', () => {
	it('separates added, removed, changed and unchanged', () => {
		const before = fromFiles({ 'keep.js': 'same', 'change.js': 'old', 'gone.js': 'x' });
		const after = fromFiles({ 'keep.js': 'same', 'change.js': 'new', 'added.js': 'y' });
		const byPath = Object.fromEntries(
			diffModules(before, after).map((f) => [f.path, f.change])
		);
		expect(byPath).toEqual({
			'added.js': 'added',
			'change.js': 'changed',
			'gone.js': 'removed',
			'keep.js': 'unchanged'
		});
	});

	it('attaches a line diff for text and none for binary', () => {
		const before = fromFiles({
			'a.js': 'one\ntwo',
			'b.bin': new Uint8Array([1, 0, 2])
		});
		const after = fromFiles({
			'a.js': 'one\nthree',
			'b.bin': new Uint8Array([1, 0, 3])
		});
		const files = diffModules(before, after);
		expect(files.find((f) => f.path === 'a.js')?.lines).toBeDefined();
		expect(files.find((f) => f.path === 'b.bin')?.lines).toBeUndefined();
	});
});

describe('diffWorkers', () => {
	it('says content was unavailable rather than implying the files match', () => {
		const diff = diffWorkers(side({ modules: null }), side());
		expect(diff.contentUnavailable).toBe('before');
		expect(diff.files).toEqual([]);
	});

	it('reports both sides missing', () => {
		expect(
			diffWorkers(side({ modules: null }), side({ modules: null })).contentUnavailable
		).toBe('both');
	});

	it('compares the runtime settings', () => {
		const diff = diffWorkers(
			side({ compatibilityDate: '2026-01-01', compatibilityFlags: ['a'] }),
			side({ compatibilityDate: '2026-08-01', compatibilityFlags: ['a', 'b'] })
		);
		expect(diff.compatibilityDate).toEqual({ before: '2026-01-01', after: '2026-08-01' });
		expect(diff.compatibilityFlags.added).toEqual(['b']);
	});

	it('compares secret names and never values, because the API returns none', () => {
		const diff = diffWorkers(
			side({ secretNames: ['OLD'] }),
			side({ secretNames: ['OLD', 'NEW'] })
		);
		expect(diff.secretNames.added).toEqual(['NEW']);
		expect(JSON.stringify(diff)).not.toMatch(/text/);
	});

	it('reports no changes for two identical sides', () => {
		expect(hasChanges(diffWorkers(side(), side()))).toBe(false);
	});

	it('reports changes when anything at all moved', () => {
		expect(hasChanges(diffWorkers(side(), side({ tags: ['wf:env=dev'] })))).toBe(true);
		expect(
			hasChanges(
				diffWorkers(
					side({ modules: fromFiles({ 'a.js': '1' }) }),
					side({ modules: fromFiles({ 'a.js': '2' }) })
				)
			)
		).toBe(true);
	});
});
