import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import { CapabilityError, UsageError } from '../../../src/client/errors.js';
import { workforce } from '../../../src/index.js';
import { dispatch, MAX_DISPATCH_TAGS } from '../../../src/plane/dispatch.js';
import { requireCapability } from '../../../src/plane/plane.js';
import { envelope, stubFetch, type StubReply } from '../../helpers/fetch.js';

function plane(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	return {
		plane: dispatch({
			accountId: 'acct',
			token: 'tok',
			namespace: 'tenants',
			fetch,
			budget: new Budget()
		}),
		calls
	};
}

describe('DispatchPlane construction', () => {
	it('needs a namespace as well as a credential', () => {
		expect(() => dispatch({ accountId: 'a', token: 't', namespace: '' })).toThrow(UsageError);
	});

	it('shares a budget with an account plane on the same token', () => {
		const d = dispatch({ accountId: 'a', token: 'shared', namespace: 'tenants' });
		expect(d.credentialKey).toBe('shared');
	});

	it('names itself by namespace and account, for an error a reader can act on', () => {
		expect(dispatch({ accountId: 'a', token: 't', namespace: 'tenants' }).target).toBe(
			'namespace tenants on account a'
		);
	});
});

describe('capabilities', () => {
	const d = dispatch({ accountId: 'a', token: 't', namespace: 'tenants' });

	it('declares what the dispatch path structurally cannot do', () => {
		expect(d.capabilities.versions.supported).toBe(false);
		expect(d.capabilities.deployments.supported).toBe(false);
		expect(d.capabilities.subdomain.supported).toBe(false);
		expect(d.capabilities.schedules.supported).toBe(false);
		expect(d.capabilities.tails.supported).toBe(false);
	});

	it('keeps what it does have', () => {
		expect(d.capabilities.assets.supported).toBe(true);
		expect(d.capabilities.tags.supported).toBe(true);
		expect(d.capabilities.maxTags).toBe(MAX_DISPATCH_TAGS);
	});

	it('gives every refusal a reason naming the mechanism', () => {
		expect(d.capabilities.versions.reason).toMatch(/no \/versions endpoint/);
		expect(d.capabilities.versions.reason).toMatch(/RevisionStore/);
		expect(() => requireCapability(d, 'versions')).toThrow(CapabilityError);
	});

	it('refuses before spending a request, not after a 404', () => {
		const { plane: p, calls } = plane([]);
		expect(() => workforce({ plane: p }).worker('x').versions).toThrow();
		expect(calls.length).toBe(0);
	});
});

describe('DispatchPlane operations', () => {
	it('addresses scripts under the namespace path', async () => {
		const { plane: p, calls } = plane([{ body: envelope([{ id: 'acme' }]) }]);
		await p.list();
		expect(calls[0]?.url).toContain(
			'/accounts/acct/workers/dispatch/namespaces/tenants/scripts'
		);
	});

	it('uploads and reports no version id, because this plane has none', async () => {
		const { plane: p } = plane([
			{ body: { success: true, result: { id: 'acme', etag: 'e1' } } }
		]);
		const result = await p.upload('acme', {
			body: new FormData(),
			metadata: { main_module: 'index.js' }
		});
		expect(result.versionId).toBeNull();
		expect(result.etag).toBe('e1');
	});

	it('reads tags from their own subresource rather than from settings', async () => {
		const { plane: p, calls } = plane([{ body: envelope(['wf:env=dev']) }]);
		expect(await p.tags('acme')).toEqual(['wf:env=dev']);
		expect(calls[0]?.url).toContain('/scripts/acme/tags');
	});

	it('refuses more than eight tags rather than letting the API drop the overflow', async () => {
		const { plane: p } = plane([]);
		const nine = Array.from({ length: 9 }, (_, i) => `wf:k${i}=v`);
		await expect(p.setTags('acme', nine)).rejects.toThrow(/allows 8 tags per script/);
	});

	it('accepts exactly eight', async () => {
		const { plane: p } = plane([{ body: envelope(null) }]);
		const eight = Array.from({ length: 8 }, (_, i) => `wf:k${i}=v`);
		await expect(p.setTags('acme', eight)).resolves.toEqual(eight);
	});
});
