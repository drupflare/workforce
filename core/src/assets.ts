/**
 * Static assets, through the upload session.
 *
 * The flow is four steps: register a manifest, receive a JWT and a list of buckets, upload each
 * bucket, receive a completion token that goes into the script upload's metadata.
 *
 * **The manifest is the complete desired file set, and that is why there is no `patch` here.**
 * `drupflare/worker/scripts/tree-diff.mjs` records what happens otherwise: a manifest of only the
 * changed paths "would carry every removed path forward onto every site". The session asks only for
 * the objects that changed, but a path the manifest omits is absent from the resulting version, and
 * that omission is the only way a rollout deletes a file. So `sync()` takes the whole tree and an
 * omission is a deletion.
 *
 * @see https://developers.cloudflare.com/workers/static-assets/direct-upload/
 */

import { UsageError } from './client/errors.js';
import type { HttpClient } from './client/fetch.js';
import { asBinary, type ModuleSet } from './source.js';

/** the session JWT is good for an hour, so a large tree re-authenticates rather than expiring */
export const SESSION_TTL_MS = 60 * 60 * 1000;

/** how close to the deadline a sync will still start a bucket */
export const SESSION_MARGIN_MS = 5 * 60 * 1000;

export interface ManifestEntry {
	hash: string;
	size: number;
}

export type AssetManifest = Record<string, ManifestEntry>;

export interface UploadSession {
	jwt: string;
	buckets: string[][];
	/** the session had nothing to upload, so the jwt it returned is already the completion token */
	complete: boolean;
}

export interface SyncResult {
	/** pass this as `assets.jwt` in the script upload metadata */
	completionToken: string;
	uploaded: number;
	/** files the session already held, which cost nothing to keep */
	reused: number;
	manifest: AssetManifest;
}

/**
 * The digest an asset manifest keys on: SHA-256, truncated to 32 hex characters.
 *
 * Truncation is the API's, not ours. A full digest is rejected.
 */
export async function hashAsset(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asBinary(bytes));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

/** Builds the manifest for a whole tree. Paths are rooted, which is what the API expects. */
export async function buildManifest(tree: ModuleSet): Promise<AssetManifest> {
	const manifest: AssetManifest = {};
	for (const [path, bytes] of tree) {
		manifest[path.startsWith('/') ? path : `/${path}`] = {
			hash: await hashAsset(bytes),
			size: bytes.byteLength
		};
	}
	return manifest;
}

function base64Of(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export interface AssetsApi {
	/** `POST /scripts/{name}/assets-upload-session` */
	startSession(manifest: AssetManifest): Promise<UploadSession>;
	/** `POST /workers/assets/upload?base64=true` */
	uploadBucket(jwt: string, files: { hash: string; bytes: Uint8Array }[]): Promise<string>;
}

/** The assets surface on an account-scoped plane. */
export function assetsApi(http: HttpClient, accountId: string, sessionPath: string): AssetsApi {
	return {
		async startSession(manifest) {
			const result = await http.request<{ jwt?: string; buckets?: string[][] }>(sessionPath, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ manifest })
			});
			const buckets = result.buckets ?? [];
			return {
				jwt: String(result.jwt ?? ''),
				buckets,
				complete: buckets.length === 0
			};
		},

		async uploadBucket(jwt, files) {
			const body = new FormData();
			for (const file of files) {
				body.set(
					file.hash,
					new Blob([new TextEncoder().encode(base64Of(file.bytes))], {
						type: 'application/null'
					}),
					file.hash
				);
			}
			const result = await http.request<{ jwt?: string }>(
				`/accounts/${accountId}/workers/assets/upload`,
				{
					method: 'POST',
					query: { base64: true },
					headers: { authorization: `Bearer ${jwt}` },
					body
				}
			);
			return String(result.jwt ?? '');
		}
	};
}

export interface SyncOptions {
	/** injectable so a test can drive the one-hour deadline without waiting an hour */
	now?: () => number;
}

/**
 * Uploads a whole asset tree and returns the completion token.
 *
 * Every path in `tree` is in the resulting version and every path absent from it is deleted, which is
 * the invariant this API exists to make unavoidable.
 */
export async function syncAssets(
	api: AssetsApi,
	tree: ModuleSet,
	options: SyncOptions = {}
): Promise<SyncResult> {
	const now = options.now ?? (() => Date.now());
	const manifest = await buildManifest(tree);

	const byHash = new Map<string, Uint8Array>();
	for (const [path, bytes] of tree) {
		byHash.set(manifest[path.startsWith('/') ? path : `/${path}`]?.hash as string, bytes);
	}

	let session = await api.startSession(manifest);
	let openedAtMs = now();
	if (session.complete) {
		return { completionToken: session.jwt, uploaded: 0, reused: tree.size, manifest };
	}

	let token = session.jwt;
	let uploaded = 0;

	for (const bucket of session.buckets) {
		// the session token lives an hour; a tree big enough to outlast it re-opens rather than
		// failing on the last bucket
		if (now() - openedAtMs > SESSION_TTL_MS - SESSION_MARGIN_MS) {
			session = await api.startSession(manifest);
			openedAtMs = now();
			token = session.jwt;
			if (session.complete) break;
		}

		const files = bucket.map((hash) => {
			const bytes = byHash.get(hash);
			if (bytes === undefined) {
				throw new UsageError(
					`the session asked for ${hash}, which is not in the tree it was built from`
				);
			}
			return { hash, bytes };
		});
		token = await api.uploadBucket(token, files);
		uploaded += files.length;
	}

	if (token === '') {
		throw new UsageError('the asset upload finished without returning a completion token');
	}
	return { completionToken: token, uploaded, reused: tree.size - uploaded, manifest };
}
