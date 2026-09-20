import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = join(root, 'action/dist/.sources');

// everything whose bytes end up inside the ncc bundle; the lockfile is here because a dependency
// bump changes the bundled code without touching a source file
const TREES = ['action/src', 'core/src'];
const FILES = ['bun.lock'];

function walk(dir) {
	const found = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...walk(path));
		else if (entry.endsWith('.ts')) found.push(path);
	}
	return found;
}

function digest(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function build() {
	const paths = [
		...TREES.flatMap((tree) => walk(join(root, tree))),
		...FILES.map((f) => join(root, f))
	];
	return paths
		.map((path) => `${digest(path)}  ${relative(root, path)}`)
		.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
		.join('\n');
}

const current = build();
const mode = process.argv[2];

if (mode === '--write') {
	writeFileSync(manifest, current + '\n');
	process.exit(0);
}

let recorded;
try {
	recorded = readFileSync(manifest, 'utf8').trimEnd();
} catch {
	console.error('action/dist/.sources is missing. Run `bun run --cwd action build`.');
	process.exit(1);
}

if (recorded === current) {
	console.log(`action/dist matches its ${current.split('\n').length} source files.`);
	process.exit(0);
}

const was = new Map(recorded.split('\n').map((l) => [l.slice(66), l.slice(0, 64)]));
const now = new Map(current.split('\n').map((l) => [l.slice(66), l.slice(0, 64)]));
for (const [path, hash] of now) {
	if (!was.has(path)) console.error(`added since the bundle was built: ${path}`);
	else if (was.get(path) !== hash) console.error(`changed since the bundle was built: ${path}`);
}
for (const path of was.keys())
	if (!now.has(path)) console.error(`removed since the bundle was built: ${path}`);

console.error('action/dist is stale. Run `bun run --cwd action build` and commit the result.');
process.exit(1);
