/**
 * Loads every published entry point the way a consumer would.
 *
 * The source-level portability spec passed while `dist/` was unloadable under node, because
 * `@drupflare/untarl` ships raw TypeScript and node refuses to strip types under `node_modules`. A
 * check that reads source cannot see that; only importing the built artifact can.
 *
 * Run after `bun run build`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const expected = {
	'.': ['workforce', 'cloudflare', 'dispatch', 'workerd', 'fromFiles', 'fromTarball'],
	'./store': ['memoryStore', 'hybridStore'],
	'./merge': ['merge'],
	'./node': ['fromDirectory']
};

let failed = 0;

for (const [subpath, names] of Object.entries(expected)) {
	const entry = subpath === '.' ? pkg.exports['.'] : pkg.exports[subpath];
	const file = new URL(`../${entry.import.replace(/^\.\//, '')}`, import.meta.url);
	try {
		const loaded = await import(file.href);
		const missing = names.filter((name) => typeof loaded[name] !== 'function');
		if (missing.length > 0) {
			console.error(`${subpath}: loaded but missing ${missing.join(', ')}`);
			failed += 1;
		} else {
			console.log(`${subpath}: ok (${names.length} exports)`);
		}
	} catch (error) {
		console.error(`${subpath}: ${error.message}`);
		failed += 1;
	}
}

// a dependency that ships raw TypeScript cannot be external, so nothing declared here may be one
for (const name of Object.keys(pkg.dependencies ?? {})) {
	try {
		const resolved = require.resolve(`${name}/package.json`);
		const dep = JSON.parse(readFileSync(resolved, 'utf8'));
		const main = dep.main ?? dep.module ?? '';
		if (typeof main === 'string' && main.endsWith('.ts')) {
			console.error(
				`${name} is a runtime dependency that publishes TypeScript (${main}); node cannot load it, so it has to be bundled instead`
			);
			failed += 1;
		}
	} catch {
		// not resolvable from here is a packaging question rather than this check's business
	}
}

if (failed > 0) {
	console.error(`\n${failed} check(s) failed against the built package.`);
	process.exit(1);
}
console.log('\nthe built package loads under plain node.');
