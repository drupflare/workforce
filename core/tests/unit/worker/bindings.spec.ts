import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import {
	assertBinding,
	assertBindings,
	diffBindings,
	inherit,
	isOpaque,
	patchBindings,
	type Binding
} from '../../../src/worker/bindings.js';

const kv = (name: string, id = 'abc'): Binding => ({
	type: 'kv_namespace',
	name,
	namespace_id: id
});

describe('assertBinding', () => {
	it('names the missing field rather than relaying a 400', () => {
		expect(() => assertBinding({ type: 'd1', name: 'DB' } as Binding)).toThrow(/needs id/);
		expect(() => assertBinding({ type: 'queue', name: 'Q' } as Binding)).toThrow(
			/needs queue_name/
		);
	});

	it('refuses a nameless binding', () => {
		expect(() => assertBinding({ type: 'ai', name: '' } as Binding)).toThrow(UsageError);
	});

	it('accepts a binding whose type needs nothing extra', () => {
		expect(() => assertBinding({ type: 'ai', name: 'AI' })).not.toThrow();
		expect(() => assertBinding({ type: 'version_metadata', name: 'V' })).not.toThrow();
	});

	it('requires only class_name for a durable object, since script_name is for cross-script', () => {
		expect(() =>
			assertBinding({ type: 'durable_object_namespace', name: 'DO', class_name: 'Room' })
		).not.toThrow();
	});
});

describe('assertBindings', () => {
	it('refuses two bindings sharing a name, which the API resolves unpredictably', () => {
		expect(() => assertBindings([kv('SAME'), kv('SAME', 'other')])).toThrow(/both named SAME/);
	});
});

describe('isOpaque', () => {
	it('reads a secret with no value as opaque, which is how the API returns one', () => {
		expect(isOpaque({ type: 'secret_text', name: 'API_KEY' } as Binding)).toBe(true);
	});

	it('reads a secret that still carries its value as comparable', () => {
		expect(isOpaque({ type: 'secret_text', name: 'API_KEY', text: 'shh' })).toBe(false);
	});

	it('reads an ordinary binding as comparable', () => {
		expect(isOpaque(kv('KV'))).toBe(false);
	});
});

describe('diffBindings', () => {
	it('separates added, changed and removed', () => {
		const before = [kv('A'), kv('B'), kv('C')];
		const after = [kv('A'), kv('B', 'changed'), kv('D')];
		const diff = diffBindings(before, after);
		expect(diff.added.map((b) => b.name)).toEqual(['D']);
		expect(diff.changed.map((c) => c.after.name)).toEqual(['B']);
		expect(diff.removed.map((b) => b.name)).toEqual(['C']);
	});

	it('puts a secret in opaque rather than claiming it changed, because the value never came back', () => {
		const before: Binding[] = [{ type: 'secret_text', name: 'S' } as Binding];
		const after: Binding[] = [{ type: 'secret_text', name: 'S', text: 'new' }];
		const diff = diffBindings(before, after);
		expect(diff.opaque).toEqual(['S']);
		expect(diff.changed).toEqual([]);
	});

	it('reads a type change as a change', () => {
		const diff = diffBindings([kv('X')], [{ type: 'r2_bucket', name: 'X', bucket_name: 'b' }]);
		expect(diff.changed.length).toBe(1);
	});

	it('is empty for two identical sets', () => {
		const diff = diffBindings([kv('A')], [kv('A')]);
		expect(diff).toEqual({ added: [], changed: [], removed: [], opaque: [] });
	});
});

describe('patchBindings', () => {
	it('inherits everything it was not asked to change, so a patch does not delete the rest', () => {
		const current = [kv('A'), kv('B'), kv('C')];
		const patched = patchBindings(current, [kv('B', 'new')]);
		expect(patched.map((b) => `${b.name}:${b.type}`)).toEqual([
			'A:inherit',
			'B:kv_namespace',
			'C:inherit'
		]);
	});

	it('appends a binding that did not exist before', () => {
		const patched = patchBindings([kv('A')], [kv('NEW')]);
		expect(patched.map((b) => b.name)).toEqual(['A', 'NEW']);
	});

	it('is every binding inherited when nothing is changed', () => {
		const patched = patchBindings([kv('A'), kv('B')], []);
		expect(patched.every((b) => b.type === 'inherit')).toBe(true);
	});

	it('refuses a patch that would produce a duplicate name', () => {
		expect(() => patchBindings([kv('A')], [kv('A'), kv('A', 'two')])).toThrow(UsageError);
	});
});

describe('inherit', () => {
	it('carries an old name when a binding is being renamed', () => {
		expect(inherit('NEW', 'OLD')).toEqual({ type: 'inherit', name: 'NEW', old_name: 'OLD' });
		expect(inherit('SAME')).toEqual({ type: 'inherit', name: 'SAME' });
	});
});
