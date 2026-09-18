/**
 * The package has to load where there is no Cloudflare runtime.
 *
 * The control plane is a Nuxt app whose server routes run on workerd under the Cloudflare preset and
 * on node everywhere else, and Nuxt's `#server-utils` barrels mean one module reaching
 * `cloudflare:sockets` breaks every file in a run rather than the one that wanted it. `@earth-app/smoke`
 * hit exactly that. So this is a test rather than a claim in a README.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src', import.meta.url).pathname;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (full.endsWith('.ts')) out.push(full);
	}
	return out;
}

const files = walk(SRC);
const relative = (file: string): string => file.slice(SRC.length + 1);

describe('the package under plain node', () => {
	it('imports its root export with no bindings and no sockets available', async () => {
		const mod = await import('../../src/index.js');
		expect(typeof mod.workforce).toBe('function');
		expect(typeof mod.cloudflare).toBe('function');
		expect(typeof mod.fromFiles).toBe('function');
	});

	it('constructs a client and a handle without a Cloudflare runtime', async () => {
		const { cloudflare, workforce } = await import('../../src/index.js');
		const client = workforce({ plane: cloudflare({ accountId: 'a', token: 't' }) });
		expect(client.worker('x').name).toBe('x');
	});

	it('never imports cloudflare: modules statically outside the lazy seam', () => {
		const offenders = files.filter((file) => {
			if (relative(file) === 'remote.ts') return false;
			return /^\s*import[^\n]*['"]cloudflare:/m.test(readFileSync(file, 'utf8'));
		});
		expect(offenders.map(relative)).toEqual([]);
	});

	it('never imports edgeport statically, since that reaches cloudflare:sockets', () => {
		const offenders = files.filter((file) =>
			/^\s*import\s[^\n]*from\s+['"]edgeport/m.test(readFileSync(file, 'utf8'))
		);
		expect(offenders.map(relative)).toEqual([]);
	});

	it('keeps node: imports inside the node subpath, so a Worker build never pulls them', () => {
		const offenders = files.filter((file) => {
			if (relative(file).startsWith('node/')) return false;
			return /from\s+['"]node:/m.test(readFileSync(file, 'utf8'));
		});
		expect(offenders.map(relative)).toEqual([]);
	});

	it('reaches edgeport only through a dynamic import', () => {
		const remote = readFileSync(join(SRC, 'remote.ts'), 'utf8');
		expect(remote).toMatch(/\bimport\(\s*'edgeport\/ssh'\s*\)/);
		expect(remote).toMatch(/\bimport\(\s*'edgeport\/sftp'\s*\)/);
		expect(remote).not.toMatch(/^\s*import\s[^\n]*from\s+['"]edgeport/m);
	});
});
