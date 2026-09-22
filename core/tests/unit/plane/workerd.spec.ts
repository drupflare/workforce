import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import {
	ApiError,
	AuthError,
	CapabilityError,
	NotFoundError,
	TransportError,
	UsageError
} from '../../../src/client/errors.js';
import { workforce } from '../../../src/index.js';
import { requireCapability } from '../../../src/plane/plane.js';
import {
	assertSiteName,
	BASTION_TOKEN_PREFIX,
	workerd,
	WorkerdPlane
} from '../../../src/plane/workerd.js';
import { stubFetch, type StubReply } from '../../helpers/fetch.js';

const ENDPOINT = 'https://node.example.edu';
const SITE = 'www.example.edu';

/** what bastion answers on the way out; `ok` rather than Cloudflare's `success`/`result` */
function node(body: Record<string, unknown>, status = 200): StubReply {
	return { status, body: { ok: true, ...body } };
}

function refused(
	status: number,
	code: string,
	message: string,
	next: string | null = null
): StubReply {
	return { status, body: { ok: false, error: { code, message, retryable: false, next } } };
}

function plane(replies: StubReply[]): {
	plane: WorkerdPlane;
	calls: ReturnType<typeof stubFetch>['calls'];
} {
	const { fetch, calls } = stubFetch(replies);
	return {
		plane: workerd({
			endpoint: ENDPOINT,
			token: 'bst_local',
			fetch,
			budget: new Budget(),
			retries: 0
		}),
		calls
	};
}

const siteRow = {
	host: SITE,
	bundle: '/srv/bundles/example.tar',
	probe: '/health',
	tags: ['wf:env=live'],
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_500_000
};

describe('WorkerdPlane construction', () => {
	it('needs an endpoint and a credential', () => {
		expect(() => workerd({ endpoint: '', token: 'bst_x' })).toThrow(UsageError);
		expect(() => workerd({ endpoint: ENDPOINT, token: '' })).toThrow(UsageError);
	});

	it('refuses a credential that is not a bastion token, before it is spent', () => {
		expect(() => workerd({ endpoint: ENDPOINT, token: 'cf-api-token' })).toThrow(
			new RegExp(`starts with ${BASTION_TOKEN_PREFIX}`)
		);
	});

	it('names itself by node, for an error a reader can act on', () => {
		expect(workerd({ endpoint: `${ENDPOINT}/`, token: 'bst_x' }).target).toBe(
			`node ${ENDPOINT}`
		);
	});

	it('shares a budget with another plane on the same credential', () => {
		expect(
			workerd({ endpoint: ENDPOINT, token: 'bst_x', budgetKey: 'shared' }).credentialKey
		).toBe('shared');
	});

	it('sends the token as a bearer header and nothing about a tenant', async () => {
		const { plane: p, calls } = plane([node({ sites: [] })]);
		await p.list();
		expect(calls[0]?.headers.authorization).toBe('Bearer bst_local');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/sites`);
	});
});

describe('capabilities', () => {
	const p = workerd({ endpoint: ENDPOINT, token: 'bst_x' });

	it('supports what bastion owns outright', () => {
		for (const capability of ['versions', 'deployments', 'assets', 'routes', 'tags'] as const) {
			expect(p.capabilities[capability].supported).toBe(true);
		}
	});

	// workerd carries no cron trigger in its schema and serves no path reaching `runScheduled`, so
	// a timer in front of the node has nothing to call. Declaring this supported would have been a
	// capability that cannot fire, which is the defect class the reason string exists to prevent
	it('refuses schedules, and names the runtime limit rather than the product', () => {
		expect(p.capabilities.schedules.supported).toBe(false);
		expect(p.capabilities.schedules.reason).toMatch(/scheduled\(\) handler/);
	});

	it('supports tails, because the node owns the process that writes the log', () => {
		expect(p.capabilities.tails.supported).toBe(true);
	});

	it('supports analytics in a bastion-native shape rather than through Cloudflare', () => {
		expect(p.capabilities.analytics.supported).toBe(true);
	});

	it('caps nothing, because the tag list is the node’s own record', () => {
		expect(p.capabilities.maxTags).toBeNull();
	});

	it('cannot do the two that belong to Cloudflare, each with a reason naming why', () => {
		expect(p.capabilities.subdomain.supported).toBe(false);
		expect(p.capabilities.subdomain.reason).toMatch(/workers\.dev/);
		expect(p.capabilities.access.supported).toBe(false);
		expect(p.capabilities.access.reason).toMatch(/Cloudflare Access/);
	});

	it('throws a CapabilityError carrying the reason when subdomain is required', () => {
		let thrown: unknown;
		try {
			requireCapability(p, 'subdomain');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CapabilityError);
		const error = thrown as CapabilityError;
		expect(error.plane).toBe('workerd');
		expect(error.capability).toBe('subdomain');
		expect(error.message).toContain('workerd does not support subdomain');
		expect(error.message).toMatch(/workers\.dev/);
	});

	it('throws the same for access', () => {
		expect(() => requireCapability(p, 'access')).toThrow(CapabilityError);
	});
});

describe('assertSiteName', () => {
	it('takes a host', () => {
		expect(() => assertSiteName(SITE)).not.toThrow();
		expect(() => assertSiteName('node')).not.toThrow();
	});

	it('refuses anything that is not one, rather than putting it in a path', () => {
		for (const bad of [
			'',
			'Www.Example.edu',
			'has space',
			'a/b',
			'-leading.edu',
			'x'.repeat(254)
		]) {
			expect(() => assertSiteName(bad)).toThrow(UsageError);
		}
	});
});

describe('listing and reading', () => {
	it('lists sites by host, sorted, and drops a row with no host', async () => {
		const { plane: p } = plane([
			node({ sites: [siteRow, { host: 'a.example.edu' }, { bundle: 'orphan' }] })
		]);
		expect((await p.list()).map((row) => row.name)).toEqual(['a.example.edu', SITE]);
	});

	it('honours a limit without asking the node to page', async () => {
		const { plane: p, calls } = plane([node({ sites: [siteRow, { host: 'a.example.edu' }] })]);
		expect(await p.list({ limit: 1 })).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});

	it('reports epoch milliseconds as the ISO string the plane interface uses', async () => {
		const { plane: p } = plane([node({ sites: [siteRow] })]);
		const summary = await p.get(SITE);
		expect(summary?.createdOn).toBe('2023-11-14T22:13:20.000Z');
		expect(summary?.id).toBe(SITE);
		expect(summary?.tags).toEqual(['wf:env=live']);
	});

	it('answers null for a site the node does not have, rather than throwing', async () => {
		const { plane: p } = plane([node({ sites: [] })]);
		expect(await p.get(SITE)).toBeNull();
		expect(await plane([node({ sites: [] })]).plane.exists(SITE)).toBe(false);
	});

	it('reads the node status', async () => {
		const { plane: p, calls } = plane([node({ version: '1.0.0', sites: 2 })]);
		expect((await p.status()).version).toBe('1.0.0');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/status`);
	});
});

describe('deploying', () => {
	it('uploads a bundle and reports the content address as both version and etag', async () => {
		const { plane: p, calls } = plane([
			node({
				version: { id: 'c0ffee', site: SITE, bytes: 12, uploadedAt: 1_700_000_000_000 }
			})
		]);
		const result = await p.upload(SITE, {
			body: new FormData(),
			metadata: { main_module: 'index.js' }
		});
		expect(result.versionId).toBe('c0ffee');
		expect(result.etag).toBe('c0ffee');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/sites/${SITE}/deploy`);
		expect(calls[0]?.method).toBe('POST');
	});

	it('creates a site with the bundle and probe a deploy cannot invent', async () => {
		const { plane: p, calls } = plane([node({ site: siteRow })]);
		const created = await p.create({ host: SITE, bundle: '/srv/b.tar', probe: '/health' });
		expect(created.name).toBe(SITE);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({
			host: SITE,
			bundle: '/srv/b.tar',
			probe: '/health'
		});
	});

	it('lists versions of one site, newest first, filtered on the rows', async () => {
		const { plane: p, calls } = plane([
			node({
				versions: [
					{ id: 'old', site: SITE, uploadedAt: 1_700_000_000_000 },
					{ id: 'other', site: 'a.example.edu', uploadedAt: 1_700_000_900_000 },
					{ id: 'new', site: SITE, uploadedAt: 1_700_000_500_000 }
				]
			})
		]);
		expect((await p.versions(SITE)).map((version) => version.id)).toEqual(['new', 'old']);
		// the tenant rides on the token, so nothing about scope is in the query
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/versions`);
	});

	it('points a site at a version it already holds', async () => {
		const { plane: p, calls } = plane([
			node({ deployment: { site: SITE, current: 'c0ffee', at: 1_700_000_000_000, by: 'ci' } })
		]);
		const deployment = await p.deployVersion(SITE, 'c0ffee');
		expect(deployment.current).toBe('c0ffee');
		expect(deployment.split).toBeNull();
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ version: 'c0ffee' });
	});

	it('splits traffic at the node’s own front door', async () => {
		const { plane: p, calls } = plane([
			node({
				deployment: { site: SITE, current: 'old', split: { version: 'new', percent: 10 } }
			})
		]);
		const deployment = await p.rollout(SITE, 'new', 10);
		expect(deployment.split).toEqual({ version: 'new', percent: 10 });
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/sites/${SITE}/rollout`);
	});

	it('refuses a share that is not one, before spending a request', async () => {
		const { plane: p, calls } = plane([]);
		await expect(p.rollout(SITE, 'new', 140)).rejects.toThrow(UsageError);
		await expect(p.rollout(SITE, 'new', Number.NaN)).rejects.toThrow(
			/not a share of a rollout/
		);
		expect(calls).toHaveLength(0);
	});

	it('deletes a site through the node, whose route may still refuse an API token', async () => {
		const { plane: p, calls } = plane([node({})]);
		await p.delete(SITE);
		expect(calls[0]?.method).toBe('DELETE');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/sites/${SITE}`);

		const refusedDelete = plane([refused(403, 'auth', 'a site delete needs a session')]);
		await expect(refusedDelete.plane.delete(SITE)).rejects.toThrow(AuthError);
	});

	it('rolls back to the previous version when none is named', async () => {
		const { plane: p, calls } = plane([node({ deployment: { site: SITE, current: 'old' } })]);
		expect((await p.rollback(SITE)).current).toBe('old');
		expect(calls[0]?.url).toBe(`${ENDPOINT}/api/sites/${SITE}/rollback`);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({});
	});

	it('rolls back to a named version', async () => {
		const { plane: p, calls } = plane([
			node({ deployment: { site: SITE, current: 'pinned' } })
		]);
		expect((await p.rollback(SITE, 'pinned')).current).toBe('pinned');
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ version: 'pinned' });
	});

	it('relays the node’s refusal of a version it never held', async () => {
		const { plane: p } = plane([
			refused(400, 'usage', `${SITE} has no version nope`, 'bastion version list')
		]);
		await expect(p.rollback(SITE, 'nope')).rejects.toThrow(ApiError);
	});
});

describe('settings and tags', () => {
	it('keeps the site record in raw rather than coercing bastion bindings into Cloudflare ones', async () => {
		const { plane: p } = plane([
			node({ sites: [{ ...siteRow, bindings: { CACHE: 'kv:cache' } }] })
		]);
		const settings = await p.settings(SITE);
		expect(settings.bindings).toEqual([]);
		expect(settings.raw.bindings).toEqual({ CACHE: 'kv:cache' });
		expect(settings.tags).toEqual(['wf:env=live']);
	});

	it('refuses a binding list instead of dropping it quietly', async () => {
		const { plane: p, calls } = plane([]);
		await expect(
			p.patchSettings(SITE, { bindings: [{ type: 'plain_text', name: 'X', text: 'y' }] })
		).rejects.toThrow(/cannot take a binding list/);
		expect(calls).toHaveLength(0);
	});

	it('merges a change into the record rather than replacing it', async () => {
		const { plane: p, calls } = plane([
			node({ sites: [siteRow] }),
			node({ site: { ...siteRow, tags: ['wf:env=dev'] } })
		]);
		expect(await p.setTags(SITE, ['wf:env=dev'])).toEqual(['wf:env=dev']);
		const written = JSON.parse(String(calls[1]?.body)) as Record<string, unknown>;
		expect(written.bundle).toBe(siteRow.bundle);
		expect(written.probe).toBe(siteRow.probe);
		expect(written.tags).toEqual(['wf:env=dev']);
	});

	it('names a site the node does not have rather than writing a new one', async () => {
		const { plane: p } = plane([node({ sites: [] })]);
		await expect(p.settings(SITE)).rejects.toThrow(NotFoundError);
	});
});

describe('logs and metrics, which is what analytics means here', () => {
	it('reads the node log and keeps the fields it does not name', async () => {
		const { plane: p, calls } = plane([
			node({
				lines: [
					{
						at: 1_700_000_000_000,
						level: 'warn',
						message: 'slow render',
						site: SITE,
						ms: 812
					}
				]
			})
		]);
		const lines = await p.logs({ site: SITE, level: 'warn', limit: 10 });
		expect(lines[0]?.at).toBe('2023-11-14T22:13:20.000Z');
		expect(lines[0]?.fields).toEqual({ ms: 812 });
		expect(calls[0]?.url).toContain('site=www.example.edu');
		expect(calls[0]?.url).toContain('limit=10');
	});

	it('reads metrics as Prometheus text, outside the JSON envelope', async () => {
		const asked: string[] = [];
		const p = workerd({
			endpoint: ENDPOINT,
			token: 'bst_local',
			budget: new Budget(),
			retries: 0,
			fetch: async (input) => {
				asked.push(String(input));
				return new Response('bastion_requests_total{site="www.example.edu"} 3\n', {
					headers: { 'content-type': 'text/plain' }
				});
			}
		});
		expect(await p.metrics()).toContain('bastion_requests_total');
		expect(asked[0]).toBe(`${ENDPOINT}/api/metrics`);
	});

	it('raises the status rather than handing back an error page as a metric', async () => {
		const { plane: p } = plane([{ status: 500, body: { ok: false } }]);
		await expect(p.metrics()).rejects.toThrow(ApiError);
	});
});

describe('what a self-hosted node has no equivalent for', () => {
	it('refuses a content read, because a node does not serve a bundle back', async () => {
		const { plane: p, calls } = plane([]);
		await expect(p.content(SITE)).rejects.toThrow(/no content to read/);
		expect(calls).toHaveLength(0);
	});

	it('refuses per-site secrets and names the command that does set them', async () => {
		const { plane: p } = plane([]);
		await expect(p.listSecrets(SITE)).rejects.toThrow(/bastion secrets set/);
		await expect(p.putSecret(SITE, { name: 'A', text: 'b' })).rejects.toThrow(UsageError);
		await expect(p.deleteSecret(SITE, 'A')).rejects.toThrow(UsageError);
	});

	it('refuses the Cloudflare version path on a handle rather than 404ing against the node', () => {
		const { plane: p, calls } = plane([]);
		expect(() => workforce({ plane: p }).worker(SITE).versions).toThrow(/versions of its own/);
		expect(calls).toHaveLength(0);
	});

	it('refuses an asset upload session, since a node serves assets out of the bundle', () => {
		const { plane: p, calls } = plane([]);
		expect(() => workforce({ plane: p }).worker(SITE).assets.sync(new Map())).toThrow(
			/out of the bundle/
		);
		expect(calls).toHaveLength(0);
	});
});

describe('the bastion envelope', () => {
	it('reads ok rather than the status, so a refusal carrying a reason survives', async () => {
		const { plane: p } = plane([refused(200, 'usage', 'nothing to roll back to')]);
		const error = await p.rollback(SITE).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).errors[0]?.message).toBe('usage: nothing to roll back to');
	});

	it('turns a rejected token into an AuthError naming the credential', async () => {
		const { plane: p } = plane([refused(401, 'auth', 'token revoked')]);
		await expect(p.list()).rejects.toThrow(AuthError);
		await expect(plane([refused(403, 'auth', 'wrong tenant')]).plane.list()).rejects.toThrow(
			AuthError
		);
	});

	it('turns a 404 into a NotFoundError', async () => {
		const { plane: p } = plane([refused(404, 'usage', 'no such site')]);
		await expect(p.upload(SITE, { body: new FormData(), metadata: {} })).rejects.toThrow(
			NotFoundError
		);
	});

	it('turns a body that is not JSON into a TransportError rather than a parse crash', async () => {
		const p = workerd({
			endpoint: ENDPOINT,
			token: 'bst_local',
			budget: new Budget(),
			retries: 0,
			fetch: async () => new Response('<html>502</html>', { status: 502 })
		});
		await expect(p.status()).rejects.toThrow(TransportError);
	});
});
