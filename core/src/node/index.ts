/**
 * The Node-only subpath.
 *
 * Everything here touches a filesystem, which is why it is not in the root export: a Worker build
 * that imported it would pull `node:fs` into a runtime that has none.
 *
 * ```ts
 * import { fromDirectory } from '@drupflare/workforce/node';
 * ```
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { UsageError } from '../client/errors.js';
import { normalisePath, type ModuleSet } from '../source.js';

export interface DirectoryOptions {
	/** skip a path, relative to the root and always with forward slashes */
	ignore?: (path: string) => boolean;
	/** stop after this many files, so a wrong root costs a refusal rather than a disk read */
	maxFiles?: number;
	maxDepth?: number;
}

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '.wrangler']);

/**
 * Reads a directory into a {@link ModuleSet}.
 *
 * Paths come back with forward slashes whatever the platform separator is, because they become module
 * names that an `import` specifier has to match.
 */
export async function fromDirectory(
	root: string,
	options: DirectoryOptions = {}
): Promise<ModuleSet> {
	const maxFiles = options.maxFiles ?? 10_000;
	const maxDepth = options.maxDepth ?? 32;
	const out: ModuleSet = new Map();

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (ALWAYS_IGNORED.has(entry.name)) continue;
			const full = join(dir, entry.name);
			const path = normalisePath(relative(root, full).split(sep).join('/'));
			if (options.ignore?.(path) === true) continue;
			if (entry.isDirectory()) {
				await walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (out.size >= maxFiles) {
				throw new UsageError(
					`${root} holds more than ${maxFiles} files; narrow the root or raise maxFiles rather than uploading a tree`
				);
			}
			out.set(path, new Uint8Array(await readFile(full)));
		}
	}

	const info = await stat(root).catch(() => null);
	if (info === null || !info.isDirectory()) {
		throw new UsageError(`${root} is not a directory`);
	}
	await walk(root, 0);
	return out;
}
