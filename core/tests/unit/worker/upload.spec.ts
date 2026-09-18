import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import { fromFiles, MODULE_CONTENT_TYPE } from '../../../src/source.js';
import {
	assertMetadata,
	buildUpload,
	carriesLifecycleChange,
	inferMain,
	METADATA_PART,
	type UploadMetadata
} from '../../../src/worker/upload.js';

async function metadataOf(body: FormData): Promise<UploadMetadata> {
	return JSON.parse(body.get(METADATA_PART) as string) as UploadMetadata;
}

describe('inferMain', () => {
	it('prefers a conventional entry point', () => {
		expect(inferMain(fromFiles({ 'index.js': '', 'util.js': '' }))).toBe('index.js');
		expect(inferMain(fromFiles({ 'worker.js': '', 'a.wasm': '' }))).toBe('worker.js');
	});

	it('takes the only script when there is exactly one', () => {
		expect(inferMain(fromFiles({ 'entry.mjs': '', 'data.bin': '' }))).toBe('entry.mjs');
	});

	it('refuses to guess between several, since guessing deploys the wrong Worker', () => {
		expect(() => inferMain(fromFiles({ 'a.js': '', 'b.js': '' }))).toThrow(
			/name the entry point/
		);
	});

	it('refuses a set with no JavaScript at all', () => {
		expect(() => inferMain(fromFiles({ 'a.wasm': '' }))).toThrow(/no JavaScript/);
	});
});

describe('assertMetadata', () => {
	it('refuses exports and migrations together, which the API rejects at validation', () => {
		expect(() =>
			assertMetadata({
				exports: { Room: { type: 'durable-object', storage: 'sqlite' } },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		).toThrow(/cannot both be set/);
	});

	it('refuses a compatibility date that is not a date', () => {
		expect(() => assertMetadata({ compatibility_date: '2026/01/01' })).toThrow(/YYYY-MM-DD/);
		expect(() => assertMetadata({ compatibility_date: '2026-01-01' })).not.toThrow();
	});

	it('requires the field each lifecycle state depends on', () => {
		expect(() =>
			assertMetadata({ exports: { A: { type: 'durable-object', state: 'renamed' } } })
		).toThrow(/needs renamed_to/);
		expect(() =>
			assertMetadata({ exports: { A: { type: 'durable-object', state: 'transferred' } } })
		).toThrow(/needs transferred_to/);
		expect(() =>
			assertMetadata({
				exports: { A: { type: 'durable-object', state: 'expecting-transfer' } }
			})
		).toThrow(/needs transfer_from/);
	});

	it('accepts an ordinary declared class', () => {
		expect(() =>
			assertMetadata({ exports: { Room: { type: 'durable-object', storage: 'sqlite' } } })
		).not.toThrow();
	});
});

describe('carriesLifecycleChange', () => {
	it('reads a migration as a lifecycle change', () => {
		expect(
			carriesLifecycleChange({ migrations: [{ tag: 'v1', new_sqlite_classes: ['A'] }] })
		).toBe(true);
	});

	it('reads a non-created export state as a lifecycle change', () => {
		expect(
			carriesLifecycleChange({
				exports: { A: { type: 'durable-object', state: 'deleted' } }
			})
		).toBe(true);
	});

	it('reads a plain declared class as no change', () => {
		expect(
			carriesLifecycleChange({
				exports: { A: { type: 'durable-object', storage: 'sqlite', state: 'created' } }
			})
		).toBe(false);
		expect(carriesLifecycleChange({})).toBe(false);
	});
});

describe('buildUpload', () => {
	it('puts the metadata in its own part and names the entry point', async () => {
		const { body } = buildUpload({ source: fromFiles({ 'index.js': 'export default {}' }) });
		expect(await metadataOf(body)).toMatchObject({ main_module: 'index.js' });
	});

	it('names each module part by its path, so imports still resolve', async () => {
		const { body } = buildUpload({
			source: fromFiles({ 'index.js': 'import "./lib/util.js"', 'lib/util.js': 'export {}' }),
			main: 'index.js'
		});
		expect(body.has('lib/util.js')).toBe(true);
		expect((body.get('lib/util.js') as File).type).toBe(MODULE_CONTENT_TYPE.esm);
	});

	it('gives each part the content type its kind requires', async () => {
		const { body } = buildUpload({
			source: fromFiles({ 'index.js': '', 'php.wasm': '', 'notes.txt': '', 'blob.bin': '' }),
			main: 'index.js'
		});
		expect((body.get('php.wasm') as File).type).toBe(MODULE_CONTENT_TYPE.wasm);
		expect((body.get('notes.txt') as File).type).toBe(MODULE_CONTENT_TYPE.text);
		expect((body.get('blob.bin') as File).type).toBe(MODULE_CONTENT_TYPE.data);
	});

	it('takes an explicit type override for a bundle that ships CommonJS', async () => {
		const { body } = buildUpload({
			source: fromFiles({ 'index.js': '' }),
			main: 'index.js',
			types: { 'index.js': 'commonjs' }
		});
		expect((body.get('index.js') as File).type).toBe(MODULE_CONTENT_TYPE.commonjs);
	});

	it('carries the metadata the caller passed through', async () => {
		const { body } = buildUpload({
			source: fromFiles({ 'index.js': '' }),
			main: 'index.js',
			metadata: {
				compatibility_date: '2026-08-01',
				compatibility_flags: ['nodejs_compat'],
				bindings: [{ type: 'kv_namespace', name: 'KV', namespace_id: 'abc' }],
				observability: { enabled: true }
			}
		});
		const metadata = await metadataOf(body);
		expect(metadata.compatibility_date).toBe('2026-08-01');
		expect(metadata.compatibility_flags).toEqual(['nodejs_compat']);
		expect(metadata.bindings?.[0]?.name).toBe('KV');
		expect(metadata.observability?.enabled).toBe(true);
	});

	it('refuses an entry point that is not in the set', () => {
		expect(() =>
			buildUpload({ source: fromFiles({ 'index.js': '' }), main: 'missing.js' })
		).toThrow(/not in the module set/);
	});

	it('refuses an empty set rather than uploading nothing', () => {
		expect(() => buildUpload({ source: new Map() })).toThrow(UsageError);
	});

	it('normalises the entry point so ./index.js and index.js agree', async () => {
		const { body } = buildUpload({
			source: fromFiles({ 'index.js': '' }),
			main: './index.js'
		});
		expect(await metadataOf(body)).toMatchObject({ main_module: 'index.js' });
	});

	it('validates the bindings it was given before spending a request', () => {
		expect(() =>
			buildUpload({
				source: fromFiles({ 'index.js': '' }),
				main: 'index.js',
				metadata: { bindings: [{ type: 'd1', name: 'DB' } as never] }
			})
		).toThrow(/needs id/);
	});
});
