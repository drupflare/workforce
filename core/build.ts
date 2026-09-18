// builds each subpath entry to dist/, then tsc emits the .d.ts tree
// run: bun run build
import { $ } from 'bun';
import { rm } from 'node:fs/promises';

const entries = {
	index: 'src/index.ts',
	'store/index': 'src/store/index.ts',
	'revisions/merge': 'src/revisions/merge.ts',
	'node/index': 'src/node/index.ts'
};

await rm('dist', { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: Object.values(entries),
	outdir: 'dist',
	root: 'src',
	target: 'node',
	format: 'esm',
	sourcemap: 'linked',
	splitting: true,
	// edgeport reaches cloudflare:sockets and is imported lazily; keeping it external is what lets
	// this package load under plain node at all.
	//
	// @drupflare/untarl is deliberately NOT external: it publishes raw TypeScript rather than a
	// build, and node refuses to strip types under node_modules, so leaving it external makes the
	// built package unloadable under node. It is dependency-free and small, so it is bundled.
	external: ['edgeport', 'edgeport/ssh', 'edgeport/sftp', 'node-diff3'],
	naming: '[dir]/[name].[ext]'
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

await $`tsc -p tsconfig.build.json`;

console.log(`built ${result.outputs.length} files`);
