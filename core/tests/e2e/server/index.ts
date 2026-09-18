/**
 * A local stand-in for the Cloudflare management API.
 *
 * `workforce({ plane: cloudflare({ baseUrl }) })` points at this and nothing in `src/` knows it is
 * not Cloudflare. It answers the same envelope, emits real `Ratelimit` headers so the governor meets
 * values it did not fabricate, and reproduces the refusals the platform is documented to make, so a
 * guard is tested against a behaviour rather than against a mock of itself.
 *
 * It optionally brings each uploaded Worker up under `wrangler dev`, which is what makes an upload
 * provably produce something that answers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { asBinary } from '../../../src/source.js';
import { PlaneState, type StoredScript, type StoredVersion } from './state.js';
import { startDevWorker, type DevWorker } from './wrangler.js';

export interface PlaneOptions {
	/** bring each uploaded worker up under wrangler dev; off by default so most specs stay fast */
	runWorkers?: boolean;
	/** the allowance reported in Ratelimit headers */
	quota?: number;
	windowSeconds?: number;
}

export interface LocalPlane {
	baseUrl: string;
	state: PlaneState;
	/** the dev server for an uploaded worker, when one was started */
	workerUrl(name: string): string | null;
	close(): Promise<void>;
}

const ACCOUNT = 'local-account';

function ok(result: unknown, extra: Record<string, unknown> = {}): unknown {
	return { success: true, errors: [], messages: [], result, ...extra };
}

function no(status: number, code: number, message: string): { status: number; body: unknown } {
	return {
		status,
		body: { success: false, errors: [{ code, message }], messages: [], result: null }
	};
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/** parses a multipart body far enough to recover the metadata part and each module */
export function parseMultipart(
	body: Buffer,
	contentType: string
): { fields: Map<string, string>; files: Map<string, Uint8Array> } {
	const marker = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	const boundary = (marker?.[1] ?? marker?.[2] ?? '').trim();
	const fields = new Map<string, string>();
	const files = new Map<string, Uint8Array>();
	if (boundary === '') return { fields, files };

	const separator = Buffer.from(`--${boundary}`);
	let at = body.indexOf(separator);
	while (at !== -1) {
		const start = at + separator.length;
		if (body.slice(start, start + 2).toString() === '--') break;
		const next = body.indexOf(separator, start);
		const chunk = body.slice(start, next === -1 ? body.length : next);
		const split = chunk.indexOf('\r\n\r\n');
		if (split !== -1) {
			const headers = chunk.slice(0, split).toString();
			const content = chunk.slice(split + 4, chunk.length - 2);
			const named = /name="([^"]*)"/i.exec(headers);
			const filename = /filename="([^"]*)"/i.exec(headers);
			const name = named?.[1] ?? '';
			if (filename !== undefined && filename !== null) {
				files.set(name, new Uint8Array(content));
			} else {
				fields.set(name, content.toString());
			}
		}
		if (next === -1) break;
		at = next;
	}
	return { fields, files };
}

/** `GET /scripts` shape: `id` IS the name here */
function summaryOf(script: StoredScript): unknown {
	return {
		id: script.name,
		created_on: script.createdOn,
		modified_on: script.modifiedOn,
		tags: script.tags
	};
}

function versionOf(version: StoredVersion): unknown {
	return {
		id: version.id,
		number: version.number,
		metadata: { created_on: version.createdOn, source: 'api' },
		annotations: version.annotations,
		resources: {
			bindings: (version.metadata.bindings as unknown[]) ?? [],
			script: { etag: version.etag },
			script_runtime: {
				compatibility_date: version.metadata.compatibility_date,
				compatibility_flags: version.metadata.compatibility_flags
			}
		}
	};
}

/** whether this upload metadata changes a Durable Object's lifecycle */
function lifecycleChange(metadata: Record<string, unknown>): boolean {
	const migrations = metadata.migrations as unknown[] | undefined;
	if (Array.isArray(migrations) && migrations.length > 0) return true;
	const exports = metadata.exports as Record<string, { state?: string }> | undefined;
	return Object.values(exports ?? {}).some((e) => e.state !== undefined && e.state !== 'created');
}

async function digestOf(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asBinary(bytes));
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

export async function startLocalPlane(options: PlaneOptions = {}): Promise<LocalPlane> {
	const state = new PlaneState();
	const dev = new Map<string, DevWorker>();
	const quota = options.quota ?? 1200;
	const windowSeconds = options.windowSeconds ?? 300;
	let spent = 0;

	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? '/', 'http://local');
		const path = url.pathname.replace(/^\/client\/v4/, '');
		const method = request.method ?? 'GET';
		state.log.push({ method, path });
		spent += 1;

		const body = await readBody(request);
		const answer = await route(method, path, url, body, request);

		response.setHeader('content-type', 'application/json');
		response.setHeader(
			'ratelimit',
			`"local";r=${Math.max(0, quota - spent)};t=${windowSeconds}`
		);
		response.setHeader('ratelimit-policy', `"local";q=${quota};w=${windowSeconds}`);
		response.statusCode = answer.status;
		response.end(
			answer.raw === undefined ? JSON.stringify(answer.body) : Buffer.from(answer.raw)
		);
	};

	async function route(
		method: string,
		path: string,
		url: URL,
		body: Buffer,
		request: IncomingMessage
	): Promise<{ status: number; body?: unknown; raw?: Uint8Array }> {
		const scripts = `/accounts/${ACCOUNT}/workers/scripts`;

		if (method === 'GET' && path === scripts) {
			return { status: 200, body: ok([...state.scripts.values()].map(summaryOf)) };
		}

		if (method === 'GET' && path === `/accounts/${ACCOUNT}/workers/scripts-search`) {
			const name = url.searchParams.get('name') ?? '';
			const matches = [...state.scripts.values()].filter((s) => s.name.includes(name));
			// the search endpoint answers with Cloudflare's hex id and a separate script_name, which
			// is NOT the shape /scripts uses. Reproduced because assuming otherwise is what made
			// exists() answer false against the real API while passing here.
			return {
				status: 200,
				body: ok(
					matches.map((script) => ({
						id: script.id,
						script_name: script.name,
						created_on: script.createdOn,
						modified_on: script.modifiedOn
					}))
				)
			};
		}

		const scriptMatch = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(path);
		if (scriptMatch !== null) {
			const name = scriptMatch[1] as string;
			const rest = scriptMatch[2] ?? '';
			return handleScript(method, name, rest, url, body, request);
		}

		return { status: 404, body: no(404, 1000, `no route for ${method} ${path}`).body };
	}

	async function handleScript(
		method: string,
		name: string,
		rest: string,
		url: URL,
		body: Buffer,
		request: IncomingMessage
	): Promise<{ status: number; body?: unknown; raw?: Uint8Array }> {
		const existing = state.scripts.get(name);

		if (method === 'PUT' && rest === '') {
			const { fields, files } = parseMultipart(body, request.headers['content-type'] ?? '');
			const metadata = JSON.parse(fields.get('metadata') ?? '{}') as Record<string, unknown>;
			const main = String(metadata.main_module ?? '');
			if (main === '' || !files.has(main)) {
				return no(400, 10021, `the entry point ${main} is not in the upload`);
			}

			const joined = Buffer.concat([...files.values()].map((f) => Buffer.from(f)));
			const etag = await digestOf(new Uint8Array(joined));
			const now = new Date().toISOString();
			const script: StoredScript = existing ?? {
				name,
				id: state.id('script'),
				createdOn: now,
				modifiedOn: now,
				tags: [],
				settings: {},
				secrets: new Map(),
				versions: [],
				deployments: [],
				subdomainEnabled: false,
				port: null,
				assets: new Map()
			};
			script.modifiedOn = now;
			script.settings = { ...script.settings, ...metadata };
			if (Array.isArray(metadata.tags)) script.tags = metadata.tags as string[];

			const version: StoredVersion = {
				id: state.id('version'),
				number: script.versions.length + 1,
				createdOn: now,
				etag,
				metadata,
				modules: files,
				annotations: (metadata.annotations as Record<string, string>) ?? {}
			};
			script.versions.unshift(version);
			script.deployments.unshift({
				id: state.id('deployment'),
				createdOn: now,
				strategy: 'percentage',
				versions: [{ version_id: version.id, percentage: 100 }]
			});
			state.scripts.set(name, script);

			if (options.runWorkers === true) {
				await dev.get(name)?.stop();
				const started = await startDevWorker({
					name,
					modules: files,
					main,
					compatibilityDate: metadata.compatibility_date as string | undefined,
					compatibilityFlags: metadata.compatibility_flags as string[] | undefined
				});
				if (started !== null) {
					dev.set(name, started);
					script.port = started.port;
				}
			}

			return { status: 200, body: ok({ id: name, etag, startup_time_ms: 1 }) };
		}

		if (existing === undefined) {
			return no(404, 10007, `workers.api.error.script_not_found: ${name}`);
		}

		if (method === 'DELETE' && rest === '') {
			await dev.get(name)?.stop();
			dev.delete(name);
			state.scripts.delete(name);
			return { status: 200, body: ok(null) };
		}

		if (rest === '/settings') {
			if (method === 'GET') {
				return {
					status: 200,
					body: ok({ ...existing.settings, tags: existing.tags })
				};
			}
			if (method === 'PATCH') {
				const { fields } = parseMultipart(body, request.headers['content-type'] ?? '');
				const patch = JSON.parse(fields.get('settings') ?? '{}') as Record<string, unknown>;
				// an inherit binding keeps whatever is deployed, so it is resolved rather than stored
				if (Array.isArray(patch.bindings)) {
					const current = (existing.settings.bindings as { name: string }[]) ?? [];
					patch.bindings = (patch.bindings as { name: string; type: string }[]).map(
						(b) =>
							b.type === 'inherit' ? (current.find((c) => c.name === b.name) ?? b) : b
					);
				}
				existing.settings = { ...existing.settings, ...patch };
				if (Array.isArray(patch.tags)) existing.tags = patch.tags as string[];
				return { status: 200, body: ok({ ...existing.settings, tags: existing.tags }) };
			}
		}

		if (rest === '/content/v2' && method === 'GET') {
			const main = String(existing.settings.main_module ?? '');
			const bytes = existing.versions[0]?.modules.get(main);
			return { status: 200, raw: bytes ?? new Uint8Array() };
		}

		if (rest === '/versions' && method === 'GET') {
			// the real endpoint wraps the list in `items` rather than answering a bare array
			return {
				status: 200,
				body: ok(
					{ items: existing.versions.map(versionOf) },
					{
						result_info: {
							page: 1,
							per_page: 10,
							count: existing.versions.length,
							total_count: existing.versions.length
						}
					}
				)
			};
		}

		if (rest === '/versions' && method === 'POST') {
			const { fields, files } = parseMultipart(body, request.headers['content-type'] ?? '');
			const metadata = JSON.parse(fields.get('metadata') ?? '{}') as Record<string, unknown>;
			// the platform refuses a version upload that carries a Durable Object lifecycle change
			if (lifecycleChange(metadata)) {
				return no(
					400,
					10220,
					'Version upload failed: Durable Object migrations cannot be uploaded as a version'
				);
			}
			const joined = Buffer.concat([...files.values()].map((f) => Buffer.from(f)));
			const version: StoredVersion = {
				id: state.id('version'),
				number: existing.versions.length + 1,
				createdOn: new Date().toISOString(),
				etag: await digestOf(new Uint8Array(joined)),
				metadata,
				modules: files,
				annotations: (metadata.annotations as Record<string, string>) ?? {}
			};
			existing.versions.unshift(version);
			return { status: 200, body: ok(versionOf(version)) };
		}

		const versionMatch = /^\/versions\/([^/]+)$/.exec(rest);
		if (versionMatch !== null && method === 'GET') {
			const found = existing.versions.find((v) => v.id === versionMatch[1]);
			if (found === undefined) return no(404, 10007, 'version not found');
			return { status: 200, body: ok(versionOf(found)) };
		}

		if (rest === '/deployments' && method === 'GET') {
			return { status: 200, body: ok({ deployments: existing.deployments }) };
		}

		if (rest === '/deployments' && method === 'POST') {
			const payload = JSON.parse(body.toString() || '{}') as {
				versions?: { version_id: string; percentage: number }[];
			};
			const versions = payload.versions ?? [];
			for (const entry of versions) {
				if (!existing.versions.some((v) => v.id === entry.version_id)) {
					return no(400, 10215, `no version ${entry.version_id} on ${name}`);
				}
			}
			const total = versions.reduce((n, v) => n + v.percentage, 0);
			if (versions.length > 0 && Math.abs(total - 100) > 0.01) {
				return no(400, 10216, `deployment percentages must total 100, not ${total}`);
			}
			const deployment = {
				id: state.id('deployment'),
				createdOn: new Date().toISOString(),
				strategy: 'percentage',
				versions
			};
			existing.deployments.unshift(deployment);
			return { status: 200, body: ok(deployment) };
		}

		if (rest === '/secrets') {
			if (method === 'GET') {
				return {
					status: 200,
					body: ok(
						[...existing.secrets.keys()].map((secret) => ({
							name: secret,
							type: 'secret_text'
						}))
					)
				};
			}
			if (method === 'PUT') {
				const payload = JSON.parse(body.toString() || '{}') as {
					name?: string;
					text?: string;
				};
				existing.secrets.set(String(payload.name), String(payload.text));
				return { status: 200, body: ok({ name: payload.name, type: 'secret_text' }) };
			}
		}

		const secretMatch = /^\/secrets\/([^/]+)$/.exec(rest);
		if (secretMatch !== null && method === 'DELETE') {
			existing.secrets.delete(decodeURIComponent(secretMatch[1] as string));
			return { status: 200, body: ok(null) };
		}

		if (rest === '/subdomain') {
			if (method === 'GET') {
				return { status: 200, body: ok({ enabled: existing.subdomainEnabled }) };
			}
			if (method === 'POST') {
				const payload = JSON.parse(body.toString() || '{}') as { enabled?: boolean };
				existing.subdomainEnabled = payload.enabled !== false;
				return { status: 200, body: ok({ enabled: existing.subdomainEnabled }) };
			}
			if (method === 'DELETE') {
				existing.subdomainEnabled = false;
				return { status: 200, body: ok({ enabled: false }) };
			}
		}

		return no(404, 1000, `no route for ${method} /scripts/${name}${rest}`);
	}

	const server: Server = createServer((request, response) => {
		void handler(request, response).catch((error: unknown) => {
			response.statusCode = 500;
			response.end(
				JSON.stringify({
					success: false,
					errors: [{ code: 1000, message: String(error) }],
					result: null
				})
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;

	return {
		baseUrl: `http://127.0.0.1:${port}/client/v4`,
		state,
		workerUrl(name) {
			return dev.get(name)?.url ?? null;
		},
		async close() {
			for (const worker of dev.values()) await worker.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

export const LOCAL_ACCOUNT = ACCOUNT;
