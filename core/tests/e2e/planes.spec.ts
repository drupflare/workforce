/**
 * One script, two planes.
 *
 * The done condition for the plane interface is that the same code provisions on either without the
 * caller branching. What differs is declared through capabilities, which is asserted here rather than
 * described.
 */

import { describe, expect, it } from 'vitest';
import { cloudflare, dispatch, fromFiles, workforce, type Plane } from '../../src/index.js';
import { LOCAL_ACCOUNT, startLocalPlane } from './server/index.js';

const source = fromFiles({
	'index.js': 'export default { fetch: () => new Response("same everywhere") };'
});

/** the operations every plane has, written once and run against each */
async function provision(plane: Plane, name: string): Promise<void> {
	const client = workforce({ plane });
	await client.worker(name).upload({
		source,
		metadata: { compatibility_date: '2026-08-01' }
	});
}

describe('the same script across planes', () => {
	it('provisions on the account plane with no branching', async () => {
		const local = await startLocalPlane();
		try {
			const plane = cloudflare({
				accountId: LOCAL_ACCOUNT,
				token: 't',
				baseUrl: local.baseUrl
			});
			await provision(plane, 'wf-e2e-both-cf');
			expect(local.state.scripts.has('wf-e2e-both-cf')).toBe(true);
		} finally {
			await local.close();
		}
	});

	it('declares the dispatch plane cannot do what the account plane can', () => {
		const cf = cloudflare({ accountId: 'a', token: 't' });
		const wfp = dispatch({ accountId: 'a', token: 't', namespace: 'tenants' });

		for (const capability of [
			'versions',
			'deployments',
			'subdomain',
			'schedules',
			'tails'
		] as const) {
			expect(cf.capabilities[capability].supported).toBe(true);
			expect(wfp.capabilities[capability].supported).toBe(false);
			expect(wfp.capabilities[capability].reason).not.toBe('');
		}
	});

	it('agrees on what both planes do have, which is what makes one script work on either', () => {
		const cf = cloudflare({ accountId: 'a', token: 't' });
		const wfp = dispatch({ accountId: 'a', token: 't', namespace: 'tenants' });
		expect(cf.capabilities.assets.supported).toBe(wfp.capabilities.assets.supported);
		expect(cf.capabilities.tags.supported).toBe(wfp.capabilities.tags.supported);
	});

	it('caps tags on the dispatch plane and not on the account plane', () => {
		expect(cloudflare({ accountId: 'a', token: 't' }).capabilities.maxTags).toBeNull();
		expect(dispatch({ accountId: 'a', token: 't', namespace: 'n' }).capabilities.maxTags).toBe(
			8
		);
	});
});
