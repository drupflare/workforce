import { cloudflare, fromFiles, workforce } from '@drupflare/workforce';
import { describe, expect, it } from 'vitest';
import { collectFromEnv } from '../src/index.js';
import { deployPreview, previewTags, readPreviewTags } from '../src/preview.js';

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
});
