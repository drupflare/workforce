import { cloudflare, fromFiles, workforce } from '@drupflare/workforce';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSameRepository, branchOf, collectFromEnv } from '../src/index.js';
import {
	deployPreview,
	destroyPreview,
	previewTags,
	readModules,
	readPreviewTags,
	translateConfig,
	withHostname
} from '../src/preview.js';

interface Call {
	method: string;
	path: string;
	search: string;
	body: BodyInit | null | undefined;
}

interface Answer {
	status?: number;
	result?: unknown;
	errors?: { code: number; message: string }[];
}

type Route = (call: Call) => Answer | undefined;

/** the first route that answers wins; a call no route answers fails with a 404 that names it */
function fakeApi(...routes: Route[]) {
	const sent: Call[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const call: Call = {
			method: init?.method ?? 'GET',
			path: url.pathname.replace(/^\/client\/v4/, ''),
			search: url.search,
			body: init?.body
		};
		sent.push(call);
		let answer: Answer | undefined;
		for (const route of routes) {
			answer = route(call);
			if (answer !== undefined) break;
		}
		const found = answer ?? {
			status: 404,
			errors: [{ code: 7000, message: `no fake for ${call.method} ${call.path}` }]
		};
		return new Response(
			JSON.stringify({
				success: (found.status ?? 200) < 300,
				errors: found.errors ?? [],
				messages: [],
				result: found.result ?? null
			}),
			{ status: found.status ?? 200, headers: { 'content-type': 'application/json' } }
		);
	};
	return {
		sent,
		workforce: workforce({ plane: cloudflare({ accountId: 'acct', token: 't', fetch }) })
	};
}

function method(verb: string, endsWith: string, answer: Answer): Route {
	return (call) => (call.method === verb && call.path.endsWith(endsWith) ? answer : undefined);
}

const scriptUpload = method('PUT', '/workers/scripts/api-pr-7', {
	result: { id: 's1', etag: 'e1' }
});
const scriptSearch = method('GET', '/workers/scripts-search', {
	result: [{ id: 's1', script_name: 'api-pr-7' }]
});
const accountSubdomain = method('GET', '/workers/subdomain', { result: { subdomain: 'acme' } });
const subdomainOn = method('POST', '/subdomain', {
	result: { enabled: true, previews_enabled: false }
});
const deployed = [scriptUpload, accountSubdomain, subdomainOn];

function uploadOf(sent: Call[]): FormData {
	return sent.find((c) => c.method === 'PUT' && c.path.includes('/workers/scripts/'))
		?.body as FormData;
}

function metadataOf(sent: Call[]): Record<string, unknown> {
	return JSON.parse(String(uploadOf(sent).get('metadata')));
}

function modulesOf(sent: Call[]): string[] {
	const names: string[] = [];
	uploadOf(sent).forEach((_value, key) => {
		if (key !== 'metadata') names.push(key);
	});
	return names.sort();
}

function bodyOf(sent: Call[], verb: string, endsWith: string): Record<string, unknown> {
	const call = sent.find((c) => c.method === verb && c.path.endsWith(endsWith));
	return JSON.parse(String(call?.body));
}

describe('previewTags', () => {
	it('writes the two a sweep later reads', () => {
		expect(previewTags(412, 1_800_000_000_000)).toEqual(['wf:pr=412', 'wf:ttl=1800000000000']);
	});

	it('stays well inside the eight a script may carry', () => {
		expect(previewTags(1, 1).length).toBeLessThanOrEqual(8);
	});
});

describe('readPreviewTags', () => {
	it('round-trips what previewTags wrote', () => {
		expect(readPreviewTags(previewTags(7, 1234))).toEqual({ pr: 7, ttlAtMs: 1234 });
	});

	it('ignores tags it does not own, so another tool sharing the script is left alone', () => {
		expect(readPreviewTags(['team:owner=platform', 'wf:pr=3'])).toEqual({
			pr: 3,
			ttlAtMs: null
		});
	});

	it('reads a non-numeric value as absent rather than as NaN', () => {
		expect(readPreviewTags(['wf:pr=soon', 'wf:ttl=never'])).toEqual({
			pr: null,
			ttlAtMs: null
		});
	});

	it('is empty for a worker with no preview tags at all', () => {
		expect(readPreviewTags([])).toEqual({ pr: null, ttlAtMs: null });
	});
});

describe('collectFromEnv', () => {
	it('resolves the named variables from the workflow env', () => {
		expect(collectFromEnv(['A', 'B'], { A: '1', B: '2', C: '3' })).toEqual({ A: '1', B: '2' });
	});

	it('refuses a name that is not there, rather than binding an empty value', () => {
		expect(() => collectFromEnv(['MISSING'], {})).toThrow(
			/listed but is not in this workflow env/
		);
	});

	it('is empty for an empty list', () => {
		expect(collectFromEnv([], { A: '1' })).toEqual({});
	});
});

describe('deployPreview', () => {
	function client(subdomain: Record<string, unknown>) {
		const seen: string[] = [];
		const fetch = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			seen.push(url);
			const body = (result: unknown) =>
				new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
					headers: { 'content-type': 'application/json' }
				});
			if (url.endsWith('/accounts/acct/workers/subdomain')) return body(subdomain);
			if (url.endsWith('/subdomain')) return body({ enabled: true, previews_enabled: false });
			return body({ id: 'api-pr-7', etag: 'e1' });
		};
		return {
			seen,
			workforce: workforce({ plane: cloudflare({ accountId: 'acct', token: 't', fetch }) })
		};
	}

	const input = {
		accountId: 'acct',
		name: 'api-pr-7',
		source: fromFiles({ 'index.js': 'export default {};' }),
		ttlAtMs: 1,
		pr: 7,
		access: false,
		accessPolicyId: null
	};

	it('returns the URL the preview actually answers on', async () => {
		const { workforce: wf } = client({ subdomain: 'acme' });
		const result = await deployPreview({ client: wf, ...input });
		expect(result.url).toBe('https://api-pr-7.acme.workers.dev');
	});

	it('reports no URL when the account has no subdomain, rather than a broken one', async () => {
		const { workforce: wf } = client({});
		const result = await deployPreview({ client: wf, ...input });
		expect(result.url).toBeNull();
	});

	it('refuses access with no policy and no emails before any request, rather than shipping an open preview', async () => {
		const api = fakeApi(...deployed);
		await expect(
			deployPreview({ ...input, client: api.workforce, access: true })
		).rejects.toThrow(/would be open/);
		expect(api.sent).toEqual([]);
	});

	it('creates one allow policy naming exactly the emails, and attaches it to the app', async () => {
		const api = fakeApi(
			...deployed,
			scriptSearch,
			method('GET', '/access/apps', { result: [] }),
			method('POST', '/access/policies', { result: { id: 'pol-1' } }),
			method('POST', '/access/apps', {
				result: { id: 'app-1', destinations: [{ worker_id: 's1' }] }
			})
		);
		await deployPreview({
			...input,
			client: api.workforce,
			access: true,
			accessEmails: ['a@example.com', 'b@example.com']
		});
		expect(bodyOf(api.sent, 'POST', '/access/policies')).toEqual({
			name: 'preview api-pr-7',
			decision: 'allow',
			include: [{ email: { email: 'a@example.com' } }, { email: { email: 'b@example.com' } }]
		});
		expect(bodyOf(api.sent, 'POST', '/access/apps').policies).toEqual(['pol-1']);
	});

	it('reuses the app already covering the Worker and creates no second policy', async () => {
		const api = fakeApi(
			...deployed,
			scriptSearch,
			method('GET', '/access/apps', {
				result: [{ id: 'app-1', destinations: [{ worker_id: 's1' }] }]
			})
		);
		await deployPreview({
			...input,
			client: api.workforce,
			access: true,
			accessEmails: ['a@example.com']
		});
		expect(api.sent.filter((c) => c.method === 'POST' && c.path.includes('/access/'))).toEqual(
			[]
		);
	});

	it('refuses a malformed access email before any request', async () => {
		const api = fakeApi(...deployed);
		await expect(
			deployPreview({
				...input,
				client: api.workforce,
				access: true,
				accessEmails: ['not-an-address']
			})
		).rejects.toThrow(/not-an-address/);
		expect(api.sent).toEqual([]);
	});

	it('removes the upload and refuses when the Worker cannot be found to attach access to', async () => {
		const api = fakeApi(
			scriptUpload,
			method('GET', '/workers/scripts-search', { result: [] }),
			method('DELETE', '/workers/scripts/api-pr-7', { result: null })
		);
		await expect(
			deployPreview({
				...input,
				client: api.workforce,
				access: true,
				accessEmails: ['a@example.com']
			})
		).rejects.toThrow(/has no id/);
		expect(api.sent.some((c) => c.method === 'DELETE' && c.path.endsWith('/api-pr-7'))).toBe(
			true
		);
	});

	it('resolves the zone before creating anything, then attaches the hostname and turns workers.dev off', async () => {
		const api = fakeApi(
			scriptUpload,
			method('GET', '/zones', { result: [{ id: 'zone-1', name: 'drupflare.com' }] }),
			method('PUT', '/workers/domains', { result: { id: 'dom-1' } }),
			method('POST', '/subdomain', { result: { enabled: false } })
		);
		const result = await deployPreview({
			...input,
			client: api.workforce,
			hostname: { hostname: 'feat-x-staging-app.drupflare.com', zone: 'drupflare.com' }
		});
		expect(result.url).toBe('https://feat-x-staging-app.drupflare.com');
		expect(api.sent[0]?.path.endsWith('/zones')).toBe(true);
		expect(api.sent[0]?.search).toBe('?name=drupflare.com');
		expect(bodyOf(api.sent, 'PUT', '/workers/domains')).toEqual({
			hostname: 'feat-x-staging-app.drupflare.com',
			zone_id: 'zone-1',
			service: 'api-pr-7',
			environment: 'production'
		});
		expect(bodyOf(api.sent, 'POST', '/subdomain')).toEqual({ enabled: false });
	});

	it('names the Zone Read permission when the zone lookup is refused, and creates nothing', async () => {
		const api = fakeApi(
			method('GET', '/zones', {
				status: 403,
				errors: [{ code: 10000, message: 'Authentication error' }]
			})
		);
		await expect(
			deployPreview({
				...input,
				client: api.workforce,
				hostname: { hostname: 'x.drupflare.com', zone: 'drupflare.com' }
			})
		).rejects.toThrow(/Zone Read/);
		expect(api.sent.length).toBe(1);
	});

	it('names the zone and the permission when no zone matches', async () => {
		const api = fakeApi(method('GET', '/zones', { result: [] }));
		await expect(
			deployPreview({
				...input,
				client: api.workforce,
				hostname: { hostname: 'x.drupflare.com', zone: 'drupflare.com' }
			})
		).rejects.toThrow(/no zone named drupflare.com.*Zone Read/);
	});

	it('uploads the config bindings and the asset completion token, with the assets binding', async () => {
		const config = translateConfig(
			JSON.stringify({
				compatibility_date: '2026-07-01',
				d1_databases: [{ binding: 'DB', database_id: 'd1-id' }]
			}),
			'/work/app/wrangler.deploy.json'
		);
		const api = fakeApi(
			...deployed,
			method('POST', '/assets-upload-session', { result: { jwt: 'completion', buckets: [] } })
		);
		await deployPreview({
			...input,
			client: api.workforce,
			config,
			assets: { binding: 'ASSETS', tree: fromFiles({ 'index.html': '<p>hi</p>' }) }
		});
		const metadata = metadataOf(api.sent);
		expect(metadata.compatibility_date).toBe('2026-07-01');
		expect(metadata.assets).toEqual({ jwt: 'completion' });
		expect(metadata.bindings).toEqual([
			{ type: 'd1', name: 'DB', id: 'd1-id' },
			{ type: 'assets', name: 'ASSETS' }
		]);
	});

	it('refuses a var and a config binding that share a name before any request', async () => {
		const config = translateConfig(
			JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'x' }] }),
			'/work/wrangler.json'
		);
		const api = fakeApi(...deployed);
		await expect(
			deployPreview({ ...input, client: api.workforce, config, vars: { DB: 'x' } })
		).rejects.toThrow(/two bindings are both named DB/);
		expect(api.sent).toEqual([]);
	});

	it('uploads the .mjs modules of a build directory and leaves out the JSON and maps beside them', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'workforce-modules-'));
		try {
			await mkdir(join(dir, 'chunks'));
			await writeFile(join(dir, 'index.mjs'), 'export default {};');
			await writeFile(join(dir, 'chunks', 'a.mjs'), 'export const a = 1;');
			await writeFile(join(dir, 'index.mjs.map'), '{}');
			await writeFile(join(dir, 'wrangler.json'), '{}');
			const api = fakeApi(...deployed);
			await deployPreview({
				...input,
				client: api.workforce,
				source: await readModules(dir)
			});
			expect(modulesOf(api.sent)).toEqual(['chunks/a.mjs', 'index.mjs']);
			expect(metadataOf(api.sent).main_module).toBe('index.mjs');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('translateConfig', () => {
	const CONFIG = '/work/app/wrangler.deploy.json';
	const parse = (value: unknown) => translateConfig(JSON.stringify(value), CONFIG);

	it('maps each binding and setting a preview can carry', () => {
		const config = parse({
			compatibility_date: '2026-07-01',
			compatibility_flags: ['nodejs_compat'],
			d1_databases: [{ binding: 'DB', database_id: 'd1-id' }],
			kv_namespaces: [{ binding: 'KV', id: 'kv-id' }],
			r2_buckets: [{ binding: 'FILES', bucket_name: 'files' }],
			send_email: [{ name: 'MAIL' }],
			vars: { SITE: 'drupflare' }
		});
		expect(config.compatibilityDate).toBe('2026-07-01');
		expect(config.compatibilityFlags).toEqual(['nodejs_compat']);
		expect(config.bindings).toEqual([
			{ type: 'd1', name: 'DB', id: 'd1-id' },
			{ type: 'kv_namespace', name: 'KV', namespace_id: 'kv-id' },
			{ type: 'r2_bucket', name: 'FILES', bucket_name: 'files' },
			{ type: 'send_email', name: 'MAIL' },
			{ type: 'plain_text', name: 'SITE', text: 'drupflare' }
		]);
		expect(config.assets).toBeNull();
	});

	it('ignores the keys a preview does not need', () => {
		const config = parse({
			$schema: 'x',
			name: 'dashboard',
			main: 'index.mjs',
			routes: [],
			workers_dev: true,
			preview_urls: true,
			observability: { enabled: true },
			triggers: { crons: [] },
			secrets: { required: ['A'] }
		});
		expect(config.bindings).toEqual([]);
	});

	it('refuses a top-level key that carries a binding it does not support, naming it', () => {
		expect(() =>
			parse({ durable_objects: { bindings: [{ name: 'X', class_name: 'Y' }] } })
		).toThrow(/durable_objects/);
	});

	it('accepts an unsupported top-level key that is empty, since nothing is dropped', () => {
		const config = parse({ services: [], durable_objects: { bindings: [] }, queues: {} });
		expect(config.bindings).toEqual([]);
	});

	it('refuses an entry field it does not support, so a binding option is not dropped quietly', () => {
		expect(() =>
			parse({ d1_databases: [{ binding: 'DB', database_id: 'x', jurisdiction: 'eu' }] })
		).toThrow(/jurisdiction/);
	});

	it('accepts the D1 fields that only configure migrations and naming', () => {
		const config = parse({
			d1_databases: [
				{
					binding: 'DB',
					database_id: 'x',
					database_name: 'n',
					migrations_dir: 'm',
					migrations_table: 't'
				}
			]
		});
		expect(config.bindings).toEqual([{ type: 'd1', name: 'DB', id: 'x' }]);
	});

	it('refuses an entry missing a field the binding needs', () => {
		expect(() => parse({ d1_databases: [{ binding: 'DB' }] })).toThrow(/needs database_id/);
	});

	it('refuses a var whose value is not a string', () => {
		expect(() => parse({ vars: { COUNT: 3 } })).toThrow(/vars\.COUNT must be a string/);
	});

	it('reads assets relative to the config file and defaults the binding to ASSETS', () => {
		expect(parse({ assets: { directory: '../public' } }).assets).toEqual({
			directory: '/work/public',
			binding: 'ASSETS'
		});
	});

	it('refuses an assets option it does not support', () => {
		expect(() =>
			parse({
				assets: { directory: '../public', not_found_handling: 'single-page-application' }
			})
		).toThrow(/not_found_handling/);
	});

	it('refuses two bindings sharing a name', () => {
		expect(() =>
			parse({
				d1_databases: [{ binding: 'X', database_id: 'a' }],
				kv_namespaces: [{ binding: 'X', id: 'b' }]
			})
		).toThrow(/two bindings are both named X/);
	});

	it('refuses a file that is not JSON', () => {
		expect(() => translateConfig('{ "name": ', CONFIG)).toThrow(/not JSON/);
	});
});

describe('destroyPreview', () => {
	const domains = method('GET', '/workers/domains', {
		result: [
			{
				id: 'dom-1',
				hostname: 'feat-x-staging-app.drupflare.com',
				zone_id: 'zone-1',
				service: 'api-pr-7',
				environment: 'production'
			},
			{
				id: 'dom-2',
				hostname: 'dashboard.drupflare.com',
				zone_id: 'zone-1',
				service: 'dashboard',
				environment: 'production'
			}
		]
	});

	it('detaches the domains pointing at the preview, then removes its Access app and the Worker', async () => {
		const api = fakeApi(
			domains,
			method('DELETE', '/workers/domains/dom-1', { result: null }),
			scriptSearch,
			method('GET', '/access/apps', {
				result: [{ id: 'app-1', destinations: [{ worker_id: 's1' }] }]
			}),
			method('DELETE', '/access/apps/app-1', { result: null }),
			method('DELETE', '/workers/scripts/api-pr-7', { result: null })
		);
		const { removed } = await destroyPreview({
			client: api.workforce,
			accountId: 'acct',
			name: 'api-pr-7'
		});
		expect(removed).toBe(true);
		expect(api.sent.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
			'/accounts/acct/workers/domains/dom-1',
			'/accounts/acct/access/apps/app-1',
			'/accounts/acct/workers/scripts/api-pr-7'
		]);
	});

	it('detaches a domain left behind by a Worker that is already gone', async () => {
		const api = fakeApi(
			domains,
			method('DELETE', '/workers/domains/dom-1', { result: null }),
			method('GET', '/workers/scripts-search', { result: [] })
		);
		const { removed } = await destroyPreview({
			client: api.workforce,
			accountId: 'acct',
			name: 'api-pr-7'
		});
		expect(removed).toBe(false);
		expect(api.sent.some((c) => c.method === 'DELETE' && c.path.endsWith('/dom-1'))).toBe(true);
	});
});

describe('assertSameRepository', () => {
	const repository = { full_name: 'drupflare/dashboard' };

	it('accepts a pull request from a branch in the same repository', () => {
		expect(() =>
			assertSameRepository({
				repository,
				pull_request: { head: { repo: { full_name: 'drupflare/dashboard' } } }
			})
		).not.toThrow();
	});

	it('refuses a pull request from a fork, naming both repositories', () => {
		expect(() =>
			assertSameRepository({
				repository,
				pull_request: { head: { repo: { full_name: 'someone/dashboard' } } }
			})
		).toThrow(/someone\/dashboard.*drupflare\/dashboard/);
	});

	it('refuses a head repository that no longer exists', () => {
		expect(() =>
			assertSameRepository({ repository, pull_request: { head: { repo: null } } })
		).toThrow(/no repository/);
	});
});

describe('branchOf', () => {
	it('reads the head ref of a pull request', () => {
		expect(branchOf({ pull_request: { head: { ref: 'feat/x' } } })).toBe('feat/x');
	});

	it('is null outside a pull request', () => {
		expect(branchOf({})).toBeNull();
	});
});

describe('withHostname', () => {
	it('fills {hostname} in a var and leaves the others alone', () => {
		expect(
			withHostname(
				{ ORIGIN: 'https://{hostname}', HOST: '{hostname}', PLAIN: 'x' },
				'a-staging-app.example.com'
			)
		).toEqual({
			ORIGIN: 'https://a-staging-app.example.com',
			HOST: 'a-staging-app.example.com',
			PLAIN: 'x'
		});
	});

	it('refuses {hostname} when there is no hostname template, rather than shipping the literal', () => {
		expect(() => withHostname({ ORIGIN: 'https://{hostname}' }, null)).toThrow(/ORIGIN/);
	});

	it('passes vars through untouched when none uses it', () => {
		expect(withHostname({ A: '1' }, null)).toEqual({ A: '1' });
	});
});
