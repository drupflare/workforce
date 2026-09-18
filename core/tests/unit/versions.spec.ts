import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import {
	assertGradualAllowed,
	assertNoLifecycleCrossing,
	assertReachable,
	assertSlices,
	assertVersionable,
	REACHABLE_VERSIONS,
	type WorkerVersion
} from '../../src/versions.js';

function version(id: string, number = 1): WorkerVersion {
	return {
		id,
		number,
		createdOn: null,
		etag: null,
		message: null,
		tag: null,
		bindings: [],
		compatibilityDate: null,
		compatibilityFlags: []
	};
}

describe('assertVersionable', () => {
	it('refuses a version carrying a migration, which the platform rejects', () => {
		expect(() =>
			assertVersionable({ migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }] })
		).toThrow(/lifecycle/);
	});

	it('refuses a version carrying a non-created export state', () => {
		expect(() =>
			assertVersionable({ exports: { Room: { type: 'durable-object', state: 'deleted' } } })
		).toThrow(/lifecycle/);
	});

	it('names what to do instead rather than only refusing', () => {
		expect(() => assertVersionable({ migrations: [{ tag: 'v1' }] })).toThrow(
			/Deploy it directly/
		);
	});

	it('allows an ordinary version, including one that declares a class without changing it', () => {
		expect(() => assertVersionable({})).not.toThrow();
		expect(() =>
			assertVersionable({
				exports: { Room: { type: 'durable-object', storage: 'sqlite', state: 'created' } }
			})
		).not.toThrow();
	});
});

describe('assertGradualAllowed', () => {
	it('refuses a split on a Worker configured with exports', () => {
		expect(() =>
			assertGradualAllowed(
				[
					{ version: 'a', percentage: 10 },
					{ version: 'b', percentage: 90 }
				],
				{ exports: { Room: { type: 'durable-object', storage: 'sqlite' } } }
			)
		).toThrow(/gradual deployment is not supported/);
	});

	it('allows a single version at 100 even with exports, since that is not a split', () => {
		expect(() =>
			assertGradualAllowed([{ version: 'a', percentage: 100 }], {
				exports: { Room: { type: 'durable-object', storage: 'sqlite' } }
			})
		).not.toThrow();
	});

	it('allows a split when there are no exports', () => {
		expect(() =>
			assertGradualAllowed(
				[
					{ version: 'a', percentage: 10 },
					{ version: 'b', percentage: 90 }
				],
				{}
			)
		).not.toThrow();
	});
});

describe('assertSlices', () => {
	it('requires the percentages to total 100', () => {
		expect(() => assertSlices([{ version: 'a', percentage: 90 }])).toThrow(/total 100/);
		expect(() =>
			assertSlices([
				{ version: 'a', percentage: 10 },
				{ version: 'b', percentage: 90 }
			])
		).not.toThrow();
	});

	it('refuses an empty deployment', () => {
		expect(() => assertSlices([])).toThrow(UsageError);
	});

	it('refuses a share that is not a share', () => {
		expect(() => assertSlices([{ version: 'a', percentage: 140 }])).toThrow(/not a share/);
	});
});

describe('assertReachable', () => {
	it('accepts a version the plane still holds', () => {
		expect(() => assertReachable([version('a'), version('b')], 'b')).not.toThrow();
	});

	it('refuses an id that is not in the list at all', () => {
		expect(() => assertReachable([version('a')], 'gone')).toThrow(/not among/);
	});

	it('refuses one past the reachable window, which is a real id that still cannot deploy', () => {
		const many = Array.from({ length: REACHABLE_VERSIONS + 5 }, (_, i) => version(`v${i}`, i));
		expect(() => assertReachable(many, 'v0')).not.toThrow();
		expect(() => assertReachable(many, `v${REACHABLE_VERSIONS + 2}`)).toThrow(/versions back/);
	});
});

describe('assertNoLifecycleCrossing', () => {
	const versions = [version('new', 3), version('middle', 2), version('old', 1)];

	it('refuses a rollback that would cross a lifecycle change', () => {
		expect(() =>
			assertNoLifecycleCrossing(versions, 'new', 'old', new Set(['middle']))
		).toThrow(/cross a Durable Object lifecycle change/);
	});

	it('allows a rollback that crosses nothing', () => {
		expect(() =>
			assertNoLifecycleCrossing(versions, 'new', 'old', new Set(['unrelated']))
		).not.toThrow();
	});

	it('is direction independent, since the crossing is the same either way', () => {
		expect(() =>
			assertNoLifecycleCrossing(versions, 'old', 'new', new Set(['middle']))
		).toThrow(/cross a Durable Object/);
	});

	it('says nothing about versions it cannot see', () => {
		expect(() =>
			assertNoLifecycleCrossing(versions, 'unknown', 'old', new Set(['middle']))
		).not.toThrow();
	});
});
