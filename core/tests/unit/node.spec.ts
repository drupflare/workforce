import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import { fromDirectory } from '../../src/node/index.js';
import { toUtf8 } from '../../src/source.js';

async function tree(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'wf-'));
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		await mkdir(join(full, '..'), { recursive: true });
		await writeFile(full, content);
	}
	return root;
}

describe('fromDirectory', () => {
	it('reads a tree with forward-slash module names', async () => {
		const root = await tree({ 'index.js': 'a', 'lib/util.js': 'b' });
		const set = await fromDirectory(root);
		expect([...set.keys()].sort()).toEqual(['index.js', 'lib/util.js']);
		expect(toUtf8(set.get('lib/util.js') as Uint8Array)).toBe('b');
	});

	it('skips the directories nobody means to upload', async () => {
		const root = await tree({
			'index.js': 'a',
			'node_modules/dep/index.js': 'x',
			'.git/HEAD': 'y'
		});
		expect([...(await fromDirectory(root)).keys()]).toEqual(['index.js']);
	});

	it('takes a caller ignore predicate', async () => {
		const root = await tree({ 'index.js': 'a', 'README.md': 'b' });
		const set = await fromDirectory(root, { ignore: (p) => p.endsWith('.md') });
		expect([...set.keys()]).toEqual(['index.js']);
	});

	it('refuses a path that is not a directory', async () => {
		await expect(fromDirectory(join(tmpdir(), 'wf-does-not-exist'))).rejects.toBeInstanceOf(
			UsageError
		);
	});

	it('refuses to read past its file ceiling rather than walking a disk', async () => {
		const root = await tree({ 'a.js': '1', 'b.js': '2', 'c.js': '3' });
		await expect(fromDirectory(root, { maxFiles: 2 })).rejects.toThrow(/more than 2 files/);
	});
});
