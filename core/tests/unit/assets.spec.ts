import { describe, expect, it } from 'vitest';
import {
	buildManifest,
	hashAsset,
	SESSION_TTL_MS,
	syncAssets,
	type AssetsApi,
	type UploadSession
} from '../../src/assets.js';
import { UsageError } from '../../src/client/errors.js';
import { fromFiles } from '../../src/source.js';

/** an assets API that behaves the way the documented flow does */
function fakeApi(options: { alreadyHave?: string[]; now?: () => number } = {}) {
	const have = new Set(options.alreadyHave ?? []);
	const uploads: string[][] = [];
	let sessions = 0;

	const api: AssetsApi = {
		async startSession(manifest): Promise<UploadSession> {
			sessions += 1;
			const wanted = Object.values(manifest)
				.map((entry) => entry.hash)
				.filter((hash) => !have.has(hash));
			if (wanted.length === 0)
				return { jwt: 'completion-token', buckets: [], complete: true };
			// the API buckets what it wants; two per bucket here so the loop is exercised
			const buckets: string[][] = [];
			for (let at = 0; at < wanted.length; at += 2) buckets.push(wanted.slice(at, at + 2));
			return { jwt: `session-${sessions}`, buckets, complete: false };
		},
		async uploadBucket(_jwt, files) {
			uploads.push(files.map((f) => f.hash));
			for (const file of files) have.add(file.hash);
			return 'completion-token';
		}
	};
	return { api, uploads, sessions: () => sessions };
}

describe('hashAsset', () => {
	it('is a 32 character hex digest, which is the length the API takes', async () => {
		const hash = await hashAsset(new TextEncoder().encode('hello'));
		expect(hash).toMatch(/^[0-9a-f]{32}$/);
	});

	it('is stable for the same bytes and different for different ones', async () => {
		const a = await hashAsset(new TextEncoder().encode('one'));
		const b = await hashAsset(new TextEncoder().encode('one'));
		const c = await hashAsset(new TextEncoder().encode('two'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe('buildManifest', () => {
	it('roots every path, which is the shape the API expects', async () => {
		const manifest = await buildManifest(fromFiles({ 'index.html': 'x', 'css/a.css': 'y' }));
		expect(Object.keys(manifest).sort()).toEqual(['/css/a.css', '/index.html']);
	});

	it('carries the byte length beside the hash', async () => {
		const manifest = await buildManifest(fromFiles({ 'a.txt': 'hello' }));
		expect(manifest['/a.txt']?.size).toBe(5);
	});
});

describe('syncAssets', () => {
	it('uploads what the session asks for and returns a completion token', async () => {
		const { api, uploads } = fakeApi();
		const result = await syncAssets(
			api,
			fromFiles({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
		);
		expect(result.completionToken).toBe('completion-token');
		expect(result.uploaded).toBe(3);
		expect(uploads.flat().length).toBe(3);
	});

	it('uploads nothing when the session already holds everything', async () => {
		const tree = fromFiles({ 'a.txt': '1' });
		const manifest = await buildManifest(tree);
		const { api, uploads } = fakeApi({ alreadyHave: [manifest['/a.txt']?.hash as string] });
		const result = await syncAssets(api, tree);
		expect(uploads).toEqual([]);
		expect(result.uploaded).toBe(0);
		expect(result.reused).toBe(1);
		expect(result.completionToken).toBe('completion-token');
	});

	it('sends the complete tree, so a path left out of it is deleted rather than carried forward', async () => {
		const { api } = fakeApi();
		const result = await syncAssets(api, fromFiles({ 'keep.txt': '1' }));
		// the manifest is the whole desired set; `gone.txt` is absent and therefore not in the version
		expect(Object.keys(result.manifest)).toEqual(['/keep.txt']);
		expect(Object.keys(result.manifest)).not.toContain('/gone.txt');
	});

	it('re-opens the session rather than failing when the hour runs out mid-tree', async () => {
		let now = 0;
		const { api, sessions } = fakeApi();
		await syncAssets(api, fromFiles({ a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' }), {
			now: () => {
				// every check advances past the session's usable life
				now += SESSION_TTL_MS;
				return now;
			}
		});
		expect(sessions()).toBeGreaterThan(1);
	});

	it('refuses when the session asks for a hash the tree does not hold', async () => {
		const api: AssetsApi = {
			async startSession() {
				return {
					jwt: 'session',
					buckets: [['deadbeefdeadbeefdeadbeefdeadbeef']],
					complete: false
				};
			},
			async uploadBucket() {
				return 'completion';
			}
		};
		await expect(syncAssets(api, fromFiles({ 'a.txt': '1' }))).rejects.toBeInstanceOf(
			UsageError
		);
	});

	it('refuses when the flow ends with no completion token', async () => {
		const api: AssetsApi = {
			async startSession(manifest) {
				return {
					jwt: 'session',
					buckets: [Object.values(manifest).map((e) => e.hash)],
					complete: false
				};
			},
			async uploadBucket() {
				return '';
			}
		};
		await expect(syncAssets(api, fromFiles({ 'a.txt': '1' }))).rejects.toThrow(
			/without returning a completion token/
		);
	});
});
