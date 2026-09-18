import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import {
	DEFAULT_ASSET_BUDGET,
	asBinary,
	fromAssets,
	fromFiles,
	fromRequest,
	fromTarball,
	fromUtf8,
	isGzip,
	moduleTypeOf,
	normalisePath,
	parseGitHubRepo,
	readAssetManifest,
	toUtf8,
	type AssetsBinding
} from '../../src/source.js';

function tarOf(files: Record<string, string>): Uint8Array {
	// a minimal ustar writer, so the reader is tested against bytes rather than against a mock
	const blocks: Uint8Array[] = [];
	const encoder = new TextEncoder();
	for (const [name, content] of Object.entries(files)) {
		const header = new Uint8Array(512);
		header.set(encoder.encode(name), 0);
		header.set(encoder.encode('0000644\0'), 100);
		header.set(encoder.encode('0000000\0'), 108);
		header.set(encoder.encode('0000000\0'), 116);
		const body = encoder.encode(content);
		header.set(encoder.encode(body.length.toString(8).padStart(11, '0') + '\0'), 124);
		header.set(encoder.encode('00000000000\0'), 136);
		header[156] = 0x30;
		header.set(encoder.encode('ustar\0'), 257);
		header.set(encoder.encode('00'), 263);
		header.set(encoder.encode(' '.repeat(8)), 148);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.set(encoder.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const block of blocks) {
		out.set(block, at);
		at += block.length;
	}
	return out;
}

describe('moduleTypeOf', () => {
	it('reads .js as a module, because a Worker bundle almost always is one', () => {
		expect(moduleTypeOf('index.js')).toBe('esm');
		expect(moduleTypeOf('worker.mjs')).toBe('esm');
	});

	it('separates commonjs, wasm, sourcemaps and text', () => {
		expect(moduleTypeOf('legacy.cjs')).toBe('commonjs');
		expect(moduleTypeOf('php.wasm')).toBe('wasm');
		expect(moduleTypeOf('index.js.map')).toBe('sourcemap');
		expect(moduleTypeOf('notes.txt')).toBe('text');
	});

	it('treats anything it does not know as bytes rather than guessing', () => {
		expect(moduleTypeOf('blob.bin')).toBe('data');
		expect(moduleTypeOf('LICENSE')).toBe('data');
	});
});

describe('normalisePath', () => {
	it('makes ./index.js and index.js one module rather than two', () => {
		expect(normalisePath('./index.js')).toBe('index.js');
		expect(normalisePath('/index.js')).toBe('index.js');
		expect(normalisePath('index.js')).toBe('index.js');
	});

	it('leaves a nested path alone', () => {
		expect(normalisePath('lib/util.js')).toBe('lib/util.js');
	});
});

describe('fromFiles', () => {
	it('encodes strings so a caller never builds a TextEncoder', () => {
		const set = fromFiles({ 'index.js': 'export default {}' });
		expect(toUtf8(set.get('index.js') as Uint8Array)).toBe('export default {}');
	});

	it('takes bytes unchanged and normalises the path', () => {
		const set = fromFiles({ './a.bin': new Uint8Array([1, 2, 3]) });
		expect([...(set.get('a.bin') as Uint8Array)]).toEqual([1, 2, 3]);
	});

	it('round-trips a module set', () => {
		const first = fromFiles({ 'a.js': 'x' });
		expect(fromFiles(first)).toEqual(first);
	});
});

describe('isGzip', () => {
	it('reads the magic number rather than a filename', () => {
		expect(isGzip(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
		expect(isGzip(new Uint8Array([0x75, 0x73]))).toBe(false);
		expect(isGzip(new Uint8Array([]))).toBe(false);
	});
});

describe('fromTarball', () => {
	it('reads a plain tar', async () => {
		const set = await fromTarball(tarOf({ 'index.js': 'export default 1' }));
		expect(toUtf8(set.get('index.js') as Uint8Array)).toBe('export default 1');
	});

	it('reads a gzipped tar, sniffed from the bytes', async () => {
		const plain = tarOf({ 'a.js': 'hello' });
		const gz = new Uint8Array(
			await new Response(
				new Response(asBinary(plain)).body?.pipeThrough(new CompressionStream('gzip'))
			).arrayBuffer()
		);
		expect(isGzip(gz)).toBe(true);
		const set = await fromTarball(gz);
		expect(toUtf8(set.get('a.js') as Uint8Array)).toBe('hello');
	});

	it('strips leading components, which is what a GitHub tarball needs', async () => {
		const set = await fromTarball(tarOf({ 'repo-abc123/index.js': 'x' }), { strip: 1 });
		expect([...set.keys()]).toEqual(['index.js']);
	});

	it('keeps only what the filter accepts', async () => {
		const set = await fromTarball(tarOf({ 'a.js': '1', 'b.md': '2' }), {
			filter: (p) => p.endsWith('.js')
		});
		expect([...set.keys()]).toEqual(['a.js']);
	});

	it('refuses a failed response rather than parsing an error page as an archive', async () => {
		await expect(fromTarball(new Response('nope', { status: 404 }))).rejects.toBeInstanceOf(
			UsageError
		);
	});
});

describe('parseGitHubRepo', () => {
	it('takes owner/repo and every github.com URL shape', () => {
		expect(parseGitHubRepo('drupflare/workforce')).toEqual({
			owner: 'drupflare',
			repo: 'workforce'
		});
		expect(parseGitHubRepo('https://github.com/drupflare/workforce')).toEqual({
			owner: 'drupflare',
			repo: 'workforce'
		});
		expect(parseGitHubRepo('https://github.com/drupflare/workforce.git')).toEqual({
			owner: 'drupflare',
			repo: 'workforce'
		});
		expect(parseGitHubRepo('github.com/drupflare/workforce/tree/main')).toEqual({
			owner: 'drupflare',
			repo: 'workforce'
		});
	});

	it('refuses something that is not a repository', () => {
		expect(() => parseGitHubRepo('https://example.com/x')).toThrow(UsageError);
	});
});

describe('fromRequest', () => {
	it('reads a multipart body, one part per module', async () => {
		const body = new FormData();
		body.set('index.js', new Blob(['export default 1']), 'index.js');
		body.set('note', 'plain');
		const set = await fromRequest(new Request('https://x/', { method: 'POST', body }));
		expect(toUtf8(set.get('index.js') as Uint8Array)).toBe('export default 1');
		expect(toUtf8(set.get('note') as Uint8Array)).toBe('plain');
	});

	it('reads a raw tar body', async () => {
		const request = new Request('https://x/', {
			method: 'POST',
			body: asBinary(tarOf({ 'a.js': 'z' })),
			headers: { 'content-type': 'application/x-tar' }
		});
		const set = await fromRequest(request);
		expect(toUtf8(set.get('a.js') as Uint8Array)).toBe('z');
	});
});

describe('readAssetManifest', () => {
	it('takes a list of paths', () => {
		expect(readAssetManifest(['a.js', 'b.js'])).toEqual(['a.js', 'b.js']);
	});

	it('takes an object keyed by path, which is what a build usually writes', () => {
		expect(readAssetManifest({ 'a.js': { size: 1 } })).toEqual(['a.js']);
	});

	it('takes a nested files list', () => {
		expect(readAssetManifest({ files: ['a.js'] })).toEqual(['a.js']);
	});

	it('refuses a shape it cannot read rather than returning nothing', () => {
		expect(() => readAssetManifest(42)).toThrow(UsageError);
	});
});

describe('fromAssets', () => {
	function binding(files: Record<string, string>, manifest: string[]): AssetsBinding {
		return {
			async fetch(input) {
				const url = new URL(typeof input === 'string' ? input : input.url);
				const path = url.pathname.replace(/^\//, '');
				if (path === 'manifest.json') return Response.json(manifest);
				const content = files[path];
				if (content === undefined) return new Response(null, { status: 404 });
				return new Response(content);
			}
		};
	}

	it('reads every file when the budget allows', async () => {
		const result = await fromAssets(
			binding({ 'a.js': '1', 'b.js': '2' }, ['a.js', 'b.js']),
			'manifest.json'
		);
		expect(result.done).toBe(true);
		expect(result.cursor).toBeUndefined();
		expect([...result.modules.keys()]).toEqual(['a.js', 'b.js']);
	});

	it('hands back a cursor when the subrequest budget runs out, rather than failing', async () => {
		const files = { 'a.js': '1', 'b.js': '2', 'c.js': '3' };
		const manifest = ['a.js', 'b.js', 'c.js'];
		const first = await fromAssets(binding(files, manifest), 'manifest.json', { budget: 2 });
		expect(first.done).toBe(false);
		expect(first.cursor).toEqual({ index: 2 });
		expect([...first.modules.keys()]).toEqual(['a.js', 'b.js']);

		const second = await fromAssets(binding(files, manifest), 'manifest.json', {
			budget: 2,
			cursor: first.cursor,
			manifest
		});
		expect(second.done).toBe(true);
		expect([...second.modules.keys()]).toEqual(['c.js']);
	});

	it('defaults the budget below the free subrequest limit', () => {
		expect(DEFAULT_ASSET_BUDGET).toBeLessThan(50);
	});

	it('records a path the binding did not serve rather than dropping it silently', async () => {
		const result = await fromAssets(
			binding({ 'a.js': '1' }, ['a.js', 'gone.js']),
			'manifest.json'
		);
		expect(result.missing).toEqual(['gone.js']);
		expect([...result.modules.keys()]).toEqual(['a.js']);
	});

	it('refuses when the manifest itself is missing, since there is nothing to enumerate', async () => {
		const empty: AssetsBinding = {
			fetch: async () => new Response(null, { status: 404 })
		};
		await expect(fromAssets(empty, 'manifest.json')).rejects.toBeInstanceOf(UsageError);
	});

	it('renames on the way in, so a build path can differ from the module name', async () => {
		const result = await fromAssets(
			binding({ 'dist/a.js': '1' }, ['dist/a.js']),
			'manifest.json',
			{
				rename: (p) => p.replace(/^dist\//, '')
			}
		);
		expect([...result.modules.keys()]).toEqual(['a.js']);
	});
});

describe('fromUtf8 and toUtf8', () => {
	it('round-trip', () => {
		expect(toUtf8(fromUtf8('hello ok'))).toBe('hello ok');
	});
});
