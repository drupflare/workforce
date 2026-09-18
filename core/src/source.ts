/**
 * Where a Worker's code comes from.
 *
 * Everything that uploads takes a {@link ModuleSet}, and that one type is what lets the same call run
 * on a laptop, inside a Worker, in CI and against any plane. A Worker provisioning another Worker is
 * a first-class case here rather than a compatibility claim, so nothing in this file touches a
 * filesystem; `fromDirectory` lives in `@drupflare/workforce/node` for the callers that have one.
 */

import { parseTar, tarEntryTree, untarGzip, type TarEntry } from '@drupflare/untarl';
import { UsageError } from './client/errors.js';
import type { Fetcher } from './client/fetch.js';

/** path to bytes. Paths are as the Worker will see them, so `index.js`, not `./dist/index.js` */
export type ModuleSet = Map<string, Uint8Array>;

/** how Cloudflare is told to treat one part of the bundle */
export type ModuleType = 'esm' | 'commonjs' | 'text' | 'data' | 'wasm' | 'sourcemap';

export const MODULE_CONTENT_TYPE: Record<ModuleType, string> = {
	esm: 'application/javascript+module',
	commonjs: 'application/javascript',
	text: 'text/plain',
	data: 'application/octet-stream',
	wasm: 'application/wasm',
	sourcemap: 'application/source-map'
};

const BY_EXTENSION: Record<string, ModuleType> = {
	js: 'esm',
	mjs: 'esm',
	ts: 'esm',
	cjs: 'commonjs',
	wasm: 'wasm',
	map: 'sourcemap',
	txt: 'text',
	html: 'text',
	css: 'text',
	json: 'text'
};

/**
 * What kind of module a path is, from its extension.
 *
 * `.js` reads as ESM because that is what a Worker bundle almost always is; a caller shipping
 * CommonJS says so explicitly rather than having it guessed from content.
 */
export function moduleTypeOf(path: string): ModuleType {
	const dot = path.lastIndexOf('.');
	if (dot === -1) return 'data';
	return BY_EXTENSION[path.slice(dot + 1).toLowerCase()] ?? 'data';
}

const encoder = new TextEncoder();

/**
 * Copies bytes into a plain `ArrayBuffer`.
 *
 * One place for one awkwardness: @cloudflare/workers-types and @types/node disagree about the
 * generic parameter on `Uint8Array`, so a `Uint8Array<ArrayBufferLike>` is rejected as a body or a
 * blob part under one of them whichever way it is written. An owned `ArrayBuffer` is accepted by
 * both. The copy is paid once per module at upload time and never on a request path.
 */
export function asBinary(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

/** accepts a string for the caller, so nobody has to build a TextEncoder to ship one file */
export function toBytes(value: Uint8Array | string): Uint8Array {
	return typeof value === 'string' ? encoder.encode(value) : value;
}

export function fromUtf8(value: string): Uint8Array {
	return encoder.encode(value);
}

export function toUtf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** strips a leading `./` or `/` so `./index.js` and `index.js` are one module rather than two */
export function normalisePath(path: string): string {
	return path.replace(/^\.?\//, '');
}

/** In-memory bytes or strings. The simplest source, and the one every other source produces. */
export function fromFiles(files: Record<string, Uint8Array | string> | ModuleSet): ModuleSet {
	const out: ModuleSet = new Map();
	const entries = files instanceof Map ? files.entries() : Object.entries(files);
	for (const [path, value] of entries) out.set(normalisePath(path), toBytes(value));
	return out;
}

/** whether these bytes begin with the gzip magic number */
export function isGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface TarballOptions {
	/** leading path components to drop; a GitHub tarball wraps everything in one directory */
	strip?: number;
	/** keep only paths the predicate accepts, after stripping */
	filter?: (path: string) => boolean;
}

function treeOf(entries: TarEntry[], options: TarballOptions): ModuleSet {
	const tree = tarEntryTree(entries, options.strip ?? 0);
	if (options.filter === undefined) return tree;
	const out: ModuleSet = new Map();
	for (const [path, bytes] of tree) if (options.filter(path)) out.set(path, bytes);
	return out;
}

/**
 * A tar or tar.gz, as bytes or as a stream.
 *
 * Gzip is detected from the magic number rather than from a filename, because the common case here is
 * a response body whose name nobody ever saw.
 */
export async function fromTarball(
	input: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | Response | Request,
	options: TarballOptions = {}
): Promise<ModuleSet> {
	if (input instanceof Response) {
		if (!input.ok) {
			throw new UsageError(`the tarball request answered HTTP ${input.status}`);
		}
		if (input.body === null) throw new UsageError('the tarball response had no body');
		return fromTarball(input.body, options);
	}

	if (input instanceof Request) {
		if (input.body === null) throw new UsageError('the tarball request had no body');
		return fromTarball(input.body, options);
	}

	if (input instanceof ReadableStream) {
		// untarGzip owns the gzip case end to end; a plain tar has to be read first to sniff it
		const bytes = await readAll(input);
		return fromTarball(bytes, options);
	}

	const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
	if (isGzip(bytes)) {
		const stream = new Response(asBinary(bytes)).body;
		if (stream === null) throw new UsageError('could not stream the gzip payload');
		return treeOf(await untarGzip(stream), options);
	}
	return treeOf(parseTar(bytes), options);
}

export interface GitHubTemplateOptions extends TarballOptions {
	ref?: string;
	/** for a private template, or to lift the unauthenticated rate limit */
	token?: string;
	fetch?: Fetcher;
}

const GITHUB_REPO =
	/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i;

/** `owner/repo`, or any github.com URL naming one */
export function parseGitHubRepo(url: string): { owner: string; repo: string } {
	const direct = /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
	if (direct !== null) return { owner: direct[1] as string, repo: direct[2] as string };
	const matched = GITHUB_REPO.exec(url.trim());
	if (matched === null) throw new UsageError(`not a GitHub repository: ${url}`);
	return { owner: matched[1] as string, repo: matched[2] as string };
}

/**
 * A template repository, through codeload.
 *
 * GitHub wraps a tarball in one `owner-repo-sha/` directory, so `strip` defaults to 1 here where it
 * defaults to 0 everywhere else. Getting that wrong produces a Worker whose main module is nested one
 * level down and whose upload is rejected for a missing entry point.
 */
export async function fromGitHub(
	url: string,
	options: GitHubTemplateOptions = {}
): Promise<ModuleSet> {
	const { owner, repo } = parseGitHubRepo(url);
	const ref = options.ref ?? 'HEAD';
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
	if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

	const response = await fetcher(
		`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
		{ headers }
	);
	if (!response.ok) {
		throw new UsageError(
			`could not fetch ${owner}/${repo}@${ref}: HTTP ${response.status}${
				response.status === 404 ? ' (private repositories need a token)' : ''
			}`
		);
	}
	return fromTarball(response, { strip: 1, ...options });
}

/**
 * Files that arrived over HTTP.
 *
 * Takes either a `multipart/form-data` body, where each part is one module, or a raw tar/tar.gz body.
 * This is the path a Worker uses when something posts it a bundle to deploy.
 */
export async function fromRequest(
	request: Request,
	options: TarballOptions = {}
): Promise<ModuleSet> {
	const type = request.headers.get('content-type') ?? '';
	if (type.includes('multipart/form-data')) {
		const form = await request.formData();
		const out: ModuleSet = new Map();
		// the two type packages declare a different value union here, so this reads the shape rather
		// than the declared type: a part either is a string or can hand back its own bytes
		for (const [name, value] of form.entries()) {
			const part = value as unknown;
			if (typeof part === 'string') {
				out.set(normalisePath(name), fromUtf8(part));
				continue;
			}
			const file = part as { name?: string; arrayBuffer(): Promise<ArrayBuffer> };
			const named = typeof file.name === 'string' && file.name !== '' ? file.name : name;
			out.set(normalisePath(named), new Uint8Array(await file.arrayBuffer()));
		}
		return out;
	}
	return fromTarball(request, options);
}

/**
 * The calling Worker's own static assets.
 *
 * An `ASSETS` binding has no listing API: you can only fetch a path you already know, so this takes a
 * manifest and reads that first. It then spends one subrequest per file, and the free plan allows 50
 * per invocation. `drupflare/worker` measured that rather than reasoning about it, after
 * `/migrate?all=1` failed with `Too many subrequests by single Worker invocation`, and settled on 40
 * against the 50 so there is room for whatever else the invocation does.
 *
 * When the budget runs out it hands back a cursor instead of failing, so the caller resumes on the
 * next invocation. An abandoned read leaves nothing behind, because the cursor is returned rather
 * than stored.
 */
export interface AssetsBinding {
	fetch(input: Request | string): Promise<Response>;
}

export interface AssetCursor {
	/** index into the manifest's path list */
	index: number;
}

export interface AssetsSource {
	modules: ModuleSet;
	done: boolean;
	/** absent when done, so a finished read cannot be resumed by accident */
	cursor?: AssetCursor;
	/** paths the manifest named that the binding did not serve */
	missing: string[];
}

export interface AssetsOptions {
	/** files to read in this invocation; 40 leaves ten subrequests of headroom on free */
	budget?: number;
	cursor?: AssetCursor;
	/** rewrite a manifest path to the name the Worker should see */
	rename?: (path: string) => string;
	/** an already-read manifest, so a resumed read does not pay for it again */
	manifest?: string[];
}

export const FREE_SUBREQUEST_LIMIT = 50;
export const DEFAULT_ASSET_BUDGET = 40;

/** accepts `["a.js"]` or `{"a.js": {...}}`, because both shapes are common in the wild */
export function readAssetManifest(body: unknown): string[] {
	if (Array.isArray(body)) return body.filter((p): p is string => typeof p === 'string');
	if (body !== null && typeof body === 'object') {
		const record = body as Record<string, unknown>;
		const nested = record.files ?? record.paths ?? record.manifest;
		if (Array.isArray(nested)) {
			return nested.filter((p): p is string => typeof p === 'string');
		}
		return Object.keys(record);
	}
	throw new UsageError(
		'the asset manifest is neither a list of paths nor an object keyed by path'
	);
}

export async function fromAssets(
	binding: AssetsBinding,
	manifestPath: string,
	options: AssetsOptions = {}
): Promise<AssetsSource> {
	let manifest = options.manifest;
	if (manifest === undefined) {
		const response = await binding.fetch(`https://assets.local/${normalisePath(manifestPath)}`);
		if (!response.ok) {
			throw new UsageError(
				`the asset manifest ${manifestPath} answered HTTP ${response.status}; without it there is nothing to enumerate`
			);
		}
		manifest = readAssetManifest(await response.json());
	}

	const budget = Math.max(1, options.budget ?? DEFAULT_ASSET_BUDGET);
	const start = options.cursor?.index ?? 0;
	const modules: ModuleSet = new Map();
	const missing: string[] = [];

	let index = start;
	let spent = 0;
	while (index < manifest.length && spent < budget) {
		const path = manifest[index] as string;
		const response = await binding.fetch(`https://assets.local/${normalisePath(path)}`);
		spent += 1;
		index += 1;
		if (!response.ok) {
			missing.push(path);
			continue;
		}
		const name = options.rename === undefined ? path : options.rename(path);
		modules.set(normalisePath(name), new Uint8Array(await response.arrayBuffer()));
	}

	const done = index >= manifest.length;
	return done ? { modules, done, missing } : { modules, done, cursor: { index }, missing };
}
