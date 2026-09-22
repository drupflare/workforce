/**
 * A local stand-in for a bastion node's management API.
 *
 * The same idea as the Cloudflare local plane beside it, against the other written-down protocol:
 * `workforce({ plane: workerd({ endpoint }) })` points at this and nothing in `src/` knows the node
 * is not real. It answers bastion's own envelope rather than Cloudflare's, keeps versions
 * content-addressed the way `deploy/versions.ts` does, and reproduces the refusals the route table
 * implies, so a guard is exercised against a behaviour rather than against a mock of itself.
 *
 * The routes are the ones in bastion's `api/routes.ts`. The tenant a token reaches is carried by the
 * token, so nothing here reads a tenant from a query or a body.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { asBinary } from '../../../src/source.js';
import { parseMultipart } from './index.js';

export interface StoredSite {
	host: string;
	bundle: string;
	probe: string;
	bindings: Record<string, string>;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

export interface StoredNodeVersion {
	id: string;
	site: string;
	bytes: number;
	uploadedAt: number;
	uploadedBy: string;
	annotations: Record<string, string>;
}

export interface StoredNodeDeployment {
	site: string;
	current: string;
	split: { version: string; percent: number } | null;
	at: number;
	by: string;
}

export class NodeState {
	readonly sites = new Map<string, StoredSite>();
	readonly versions: StoredNodeVersion[] = [];
	readonly deployments = new Map<string, StoredNodeDeployment>();
	readonly history = new Map<string, string[]>();
	readonly lines: Record<string, unknown>[] = [];
	readonly log: { method: string; path: string; authorized: boolean }[] = [];

	reset(): void {
		this.sites.clear();
		this.versions.length = 0;
		this.deployments.clear();
		this.history.clear();
		this.lines.length = 0;
		this.log.length = 0;
	}
}

export interface LocalNode {
	endpoint: string;
	token: string;
	state: NodeState;
	close(): Promise<void>;
}

export interface NodeOptions {
	/** the one token this node accepts, so an unauthorized call is testable */
	token?: string;
}

const TOKEN_PREFIX = 'bst_';

function ok(body: Record<string, unknown> = {}): { status: number; body: unknown } {
	return { status: 200, body: { ok: true, ...body } };
}

function no(
	status: number,
	code: string,
	message: string,
	next: string | null = null
): { status: number; body: unknown } {
	return { status, body: { ok: false, error: { code, message, retryable: false, next } } };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/** the content address bastion keys a version on; two identical bundles are one version */
async function versionId(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asBinary(bytes));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

export async function startLocalNode(options: NodeOptions = {}): Promise<LocalNode> {
	const state = new NodeState();
	const token = options.token ?? `${TOKEN_PREFIX}local`;

	async function route(
		method: string,
		path: string,
		url: URL,
		body: Buffer,
		request: IncomingMessage
	): Promise<{ status: number; body: unknown }> {
		if (method === 'GET' && path === '/api/status') {
			return ok({ version: '1.0.0', sites: state.sites.size, healthy: true });
		}

		if (method === 'GET' && path === '/api/metrics') {
			const total = state.versions.length;
			return {
				status: 200,
				body: `# TYPE bastion_versions_total counter\nbastion_versions_total ${total}\n`
			};
		}

		if (method === 'GET' && path === '/api/logs') {
			const site = url.searchParams.get('site');
			const lines = state.lines.filter((line) => site === null || line.site === site);
			return ok({ lines });
		}

		if (method === 'GET' && path === '/api/sites') {
			return ok({ sites: [...state.sites.values()] });
		}

		if (method === 'POST' && path === '/api/sites') {
			const payload = JSON.parse(body.toString() || '{}') as Partial<StoredSite>;
			const host = String(payload.host ?? '');
			if (host === '') return no(400, 'usage', 'a site needs a host', 'bastion site add');
			const now = Date.now();
			const existing = state.sites.get(host);
			const site: StoredSite = {
				host,
				bundle: String(payload.bundle ?? existing?.bundle ?? ''),
				probe: String(payload.probe ?? existing?.probe ?? '/'),
				bindings: payload.bindings ?? existing?.bindings ?? {},
				tags: payload.tags ?? existing?.tags ?? [],
				createdAt: existing?.createdAt ?? now,
				updatedAt: now
			};
			state.sites.set(host, site);
			return ok({ site });
		}

		if (method === 'GET' && path === '/api/versions') {
			return ok({ versions: state.versions });
		}

		const match = /^\/api\/sites\/([^/]+)(\/.*)?$/.exec(path);
		if (match === null) return no(404, 'usage', `no route for ${method} ${path}`);

		const host = match[1] as string;
		const rest = match[2] ?? '';
		const site = state.sites.get(host);
		if (site === undefined) {
			return no(404, 'usage', `no site named ${host} on this node`, 'bastion site add');
		}

		if (method === 'DELETE' && rest === '') {
			// the route table marks a site delete session-only, so an API token is refused here
			return no(403, 'auth', 'a site delete needs an interactive session', 'bastion site rm');
		}

		if (method === 'POST' && rest === '/deploy') {
			const contentType = request.headers['content-type'] ?? '';
			if (contentType.includes('application/json')) {
				const payload = JSON.parse(body.toString() || '{}') as { version?: string };
				const id = String(payload.version ?? '');
				if (!state.versions.some((v) => v.site === host && v.id === id)) {
					return no(400, 'usage', `${host} has no version ${id}`, 'bastion version list');
				}
				return ok({ deployment: pointAt(host, id) });
			}

			const { fields, files } = parseMultipart(body, contentType);
			const metadata = JSON.parse(fields.get('metadata') ?? '{}') as Record<string, unknown>;
			const main = String(metadata.main_module ?? '');
			if (main === '' || !files.has(main)) {
				return no(400, 'usage', `the entry point ${main} is not in the bundle`);
			}
			const joined = Buffer.concat([...files.values()].map((file) => Buffer.from(file)));
			const id = await versionId(new Uint8Array(joined));
			const existing = state.versions.find((v) => v.site === host && v.id === id);
			const version = existing ?? {
				id,
				site: host,
				bytes: joined.length,
				uploadedAt: Date.now(),
				uploadedBy: 'token',
				annotations: (metadata.annotations as Record<string, string>) ?? {}
			};
			if (existing === undefined) state.versions.push(version);
			state.lines.push({
				at: Date.now(),
				level: 'info',
				message: 'deployed',
				site: host,
				version: id
			});
			return ok({ version, deployment: pointAt(host, id) });
		}

		if (method === 'POST' && rest === '/rollout') {
			const payload = JSON.parse(body.toString() || '{}') as {
				version?: string;
				percent?: number;
			};
			const id = String(payload.version ?? '');
			const percent = payload.percent ?? 0;
			if (!state.versions.some((v) => v.site === host && v.id === id)) {
				return no(400, 'usage', `${host} has no version ${id}`, 'bastion version list');
			}
			const current = state.deployments.get(host);
			if (current === undefined) {
				return no(400, 'usage', `${host} has nothing deployed yet`, 'bastion deploy');
			}
			const deployment: StoredNodeDeployment = {
				...current,
				split: percent === 0 ? null : { version: id, percent },
				at: Date.now(),
				by: 'token'
			};
			state.deployments.set(host, deployment);
			return ok({ deployment });
		}

		if (method === 'POST' && rest === '/rollback') {
			const payload = JSON.parse(body.toString() || '{}') as { version?: string };
			if (payload.version !== undefined) {
				const id = String(payload.version);
				if (!state.versions.some((v) => v.site === host && v.id === id)) {
					return no(400, 'usage', `${host} has no version ${id}`, 'bastion version list');
				}
				return ok({ deployment: pointAt(host, id) });
			}
			const past = state.history.get(host) ?? [];
			const current = state.deployments.get(host)?.current;
			const previous = [...past].reverse().find((id) => id !== current);
			if (previous === undefined) {
				return no(
					400,
					'usage',
					`${host} has nothing to roll back to`,
					'bastion version list'
				);
			}
			return ok({ deployment: pointAt(host, previous) });
		}

		return no(404, 'usage', `no route for ${method} ${path}`);
	}

	function pointAt(host: string, id: string): StoredNodeDeployment {
		const deployment: StoredNodeDeployment = {
			site: host,
			current: id,
			split: null,
			at: Date.now(),
			by: 'token'
		};
		state.deployments.set(host, deployment);
		state.history.set(host, [...(state.history.get(host) ?? []), id]);
		return deployment;
	}

	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? '/', 'http://local');
		const method = request.method ?? 'GET';
		const presented = (request.headers.authorization ?? '').replace(/^Bearer /, '');
		const authorized = presented === token;
		state.log.push({ method, path: url.pathname, authorized });

		const body = await readBody(request);
		const answer = authorized
			? await route(method, url.pathname, url, body, request)
			: no(401, 'auth', 'the token was rejected', 'bastion token create');

		const text = typeof answer.body === 'string';
		response.setHeader('content-type', text ? 'text/plain' : 'application/json');
		response.statusCode = answer.status;
		response.end(text ? (answer.body as string) : JSON.stringify(answer.body));
	};

	const server: Server = createServer((request, response) => {
		void handler(request, response).catch((error: unknown) => {
			response.statusCode = 500;
			response.end(
				JSON.stringify({ ok: false, error: { code: 'internal', message: String(error) } })
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;

	return {
		endpoint: `http://127.0.0.1:${port}`,
		token,
		state,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}
