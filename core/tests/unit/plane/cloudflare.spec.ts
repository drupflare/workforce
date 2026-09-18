import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/client/budget.js';
import { CapabilityError, NotFoundError, UsageError } from '../../../src/client/errors.js';
import { workforce } from '../../../src/index.js';
import { assertWorkerName, cloudflare } from '../../../src/plane/cloudflare.js';
import { requireCapability } from '../../../src/plane/plane.js';
import { fromFiles } from '../../../src/source.js';
import { envelope, stubFetch, type StubReply } from '../../helpers/fetch.js';

function plane(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	return {
		plane: cloudflare({
			accountId: 'acct',
			token: 'tok',
			fetch,
			budget: new Budget({ concurrency: 4 })
		}),
		calls
	};
}

describe('assertWorkerName', () => {
	it('accepts what Cloudflare accepts', () => {
		expect(() => assertWorkerName('my-api')).not.toThrow();
		expect(() => assertWorkerName('a1')).not.toThrow();
	});

	it('refuses a name the API would mangle rather than reject', () => {
		expect(() => assertWorkerName('My-API')).toThrow(UsageError);
		expect(() => assertWorkerName('-leading')).toThrow(UsageError);
		expect(() => assertWorkerName('has space')).toThrow(UsageError);
		expect(() => assertWorkerName('')).toThrow(UsageError);
	});
});

describe('CloudflarePlane', () => {
	it('refuses to construct without a credential', () => {
		expect(() => cloudflare({ accountId: '', token: 't' })).toThrow(UsageError);
		expect(() => cloudflare({ accountId: 'a', token: '' })).toThrow(UsageError);
	});

	it('keys its budget on the token, so two accounts on one token share a governor', () => {
		const a = cloudflare({ accountId: 'one', token: 'shared' });
		const b = cloudflare({ accountId: 'two', token: 'shared' });
		expect(a.credentialKey).toBe(b.credentialKey);
	});

	it('takes an explicit budget key for a caller who knows two tokens are one user', () => {
		const a = cloudflare({ accountId: 'one', token: 'tok-a', budgetKey: 'gregory' });
		const b = cloudflare({ accountId: 'two', token: 'tok-b', budgetKey: 'gregory' });
		expect(a.credentialKey).toBe(b.credentialKey);
	});

	it('lists workers sorted, dropping any row with no id', async () => {
		const { plane: p } = plane([
			{ body: envelope([{ id: 'zed' }, { id: 'alpha' }, { id: '' }]) }
		]);
		expect((await p.list()).map((w) => w.name)).toEqual(['alpha', 'zed']);
	});

	it('answers null for a worker that is not there, rather than throwing', async () => {
		const { plane: p } = plane([{ body: envelope([]) }]);
		expect(await p.get('missing')).toBeNull();
	});

	it('matches only an exact name, since the search endpoint also returns partials', async () => {
		const { plane: p } = plane([
			{ body: envelope([{ id: 'my-api-staging' }, { id: 'my-api' }]) }
		]);
		expect((await p.get('my-api'))?.name).toBe('my-api');
	});

	it('uploads as multipart and reports the etag the plane returned', async () => {
		const { plane: p, calls } = plane([
			{ body: { success: true, result: { id: 'my-api', etag: 'abc123' } } }
		]);
		const result = await p.upload('my-api', {
			body: new FormData(),
			metadata: { main_module: 'index.js' }
		});
		expect(result.etag).toBe('abc123');
		expect(calls[0]?.method).toBe('PUT');
		expect(calls[0]?.url).toContain('/accounts/acct/workers/scripts/my-api');
	});

	it('names an upload refusal rather than relaying an empty result', async () => {
		const { plane: p } = plane([
			{ body: { success: false, errors: [{ code: 10021, message: 'binding is invalid' }] } }
		]);
		await expect(p.upload('my-api', { body: new FormData(), metadata: {} })).rejects.toThrow(
			/binding is invalid/
		);
	});

	it('reads settings into a shape that keeps whatever it did not model', async () => {
		const { plane: p } = plane([
			{
				body: envelope({
					bindings: [{ type: 'kv_namespace', name: 'KV', namespace_id: 'x' }],
					compatibility_date: '2026-08-01',
					something_new: true
				})
			}
		]);
		const settings = await p.settings('my-api');
		expect(settings.compatibilityDate).toBe('2026-08-01');
		expect(settings.raw.something_new).toBe(true);
	});

	it('sends a settings patch as multipart under the settings key', async () => {
		const { plane: p, calls } = plane([{ body: envelope({ tags: ['wf:env=dev'] }) }]);
		await p.patchSettings('my-api', { tags: ['wf:env=dev'] });
		expect(calls[0]?.method).toBe('PATCH');
		expect(calls[0]?.body).toBeInstanceOf(FormData);
	});

	it('deletes with force, because a Worker with a service binding refuses otherwise', async () => {
		const { plane: p, calls } = plane([{ body: envelope(null) }]);
		await p.delete('my-api');
		expect(calls[0]?.url).toContain('force=true');
	});
});

describe('capabilities', () => {
	it('reports the cloudflare plane as able to do everything', () => {
		const p = cloudflare({ accountId: 'a', token: 't' });
		expect(p.capabilities.versions.supported).toBe(true);
		expect(p.capabilities.deployments.supported).toBe(true);
		expect(() => requireCapability(p, 'versions')).not.toThrow();
	});

	it('throws a named CapabilityError when something is unsupported', () => {
		const fake = {
			kind: 'dispatch' as const,
			capabilities: {
				...cloudflare({ accountId: 'a', token: 't' }).capabilities,
				versions: {
					supported: false,
					reason: 'dispatch scripts have no /versions endpoint'
				}
			}
		};
		expect(() => requireCapability(fake, 'versions')).toThrow(CapabilityError);
		expect(() => requireCapability(fake, 'versions')).toThrow(/no \/versions endpoint/);
	});
});

describe('Workforce', () => {
	it('hands back a handle without touching the network', () => {
		const { plane: p, calls } = plane([]);
		const handle = workforce({ plane: p }).worker('my-api');
		expect(handle.name).toBe('my-api');
		expect(calls.length).toBe(0);
	});

	it('require() names the worker rather than answering null', async () => {
		const { plane: p } = plane([{ body: envelope([]) }]);
		await expect(workforce({ plane: p }).worker('gone').require()).rejects.toBeInstanceOf(
			NotFoundError
		);
	});

	it('reads the current bindings before patching, so the rest are inherited', async () => {
		const { plane: p, calls } = plane([
			{
				body: envelope({
					bindings: [
						{ type: 'kv_namespace', name: 'KEEP', namespace_id: 'k' },
						{ type: 'kv_namespace', name: 'CHANGE', namespace_id: 'old' }
					]
				})
			},
			{ body: envelope({ bindings: [] }) }
		]);
		await workforce({ plane: p })
			.worker('my-api')
			.patchSettings({
				bindings: [{ type: 'kv_namespace', name: 'CHANGE', namespace_id: 'new' }]
			});

		const sent = JSON.parse((calls[1]?.body as FormData).get('settings') as string) as {
			bindings: { name: string; type: string }[];
		};
		expect(sent.bindings.map((b) => `${b.name}:${b.type}`)).toEqual([
			'KEEP:inherit',
			'CHANGE:kv_namespace'
		]);
	});

	it('exposes the raw client as an escape hatch', async () => {
		const { plane: p } = plane([{ body: envelope({ anything: true }) }]);
		const raw = await workforce({ plane: p }).raw.request<{ anything: boolean }>('/whatever');
		expect(raw.anything).toBe(true);
	});

	it('uploads through the handle with a built body', async () => {
		const { plane: p, calls } = plane([
			{ body: { success: true, result: { id: 'my-api', etag: 'e' } } }
		]);
		await workforce({ plane: p })
			.worker('my-api')
			.upload({ source: fromFiles({ 'index.js': 'export default {}' }) });
		expect(calls[0]?.body).toBeInstanceOf(FormData);
	});
});
