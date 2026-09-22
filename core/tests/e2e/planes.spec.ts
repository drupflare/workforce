/**
 * One script, three planes.
 *
 * The done condition for the plane interface is that the same code provisions on any of them without
 * the caller branching. What differs is declared through capabilities, which is asserted here rather
 * than described.
 */

import { describe, expect, it } from 'vitest';
import {
	buildUpload,
	cloudflare,
	dispatch,
	fromFiles,
	workerd,
	workforce,
	type BuiltUpload,
	type Plane
} from '../../src/index.js';
import { startLocalNode } from './server/bastion.js';
import { LOCAL_ACCOUNT, startLocalPlane } from './server/index.js';

const source = fromFiles({
	'index.js': 'export default { fetch: () => new Response("same everywhere") };'
});

/** one bundle, built the way a caller's upload is, for the calls that take a plane directly */
function buildFor(body: string): BuiltUpload {
	return buildUpload({
		source: fromFiles({
			'index.js': `export default { fetch: () => new Response("${body}") };`
		}),
		metadata: { compatibility_date: '2026-08-01' }
	});
}

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

	it('provisions on the workerd plane with the same call', async () => {
		const node = await startLocalNode();
		try {
			const plane = workerd({ endpoint: node.endpoint, token: node.token });
			await plane.create({
				host: 'wf-e2e-both.example',
				bundle: '/srv/bundles/e2e.tar',
				probe: '/health'
			});
			await provision(plane, 'wf-e2e-both.example');
			expect(node.state.versions).toHaveLength(1);
			expect(node.state.deployments.get('wf-e2e-both.example')?.current).toBe(
				node.state.versions[0]?.id
			);
		} finally {
			await node.close();
		}
	});

	it('declares what a self-hosted node has no equivalent for', () => {
		const cf = cloudflare({ accountId: 'a', token: 't' });
		const node = workerd({ endpoint: 'https://node.example', token: 'bst_t' });

		// subdomain and access belong to Cloudflare's network; schedules are absent for a different
		// reason, which is that workerd itself carries no cron trigger to drive
		for (const capability of ['subdomain', 'access', 'schedules'] as const) {
			expect(cf.capabilities[capability].supported).toBe(true);
			expect(node.capabilities[capability].supported).toBe(false);
			expect(node.capabilities[capability].reason).not.toBe('');
		}
		// bastion owns its store and its router, so the half a dispatch namespace lacks is real here
		for (const capability of ['versions', 'deployments', 'tails'] as const) {
			expect(node.capabilities[capability].supported).toBe(true);
		}
	});
});

describe('the workerd plane against a local node', () => {
	it('walks upload, version, rollout and rollback over the written-down protocol', async () => {
		const node = await startLocalNode();
		const plane = workerd({ endpoint: node.endpoint, token: node.token });
		const site = 'wf-e2e-node.example';
		try {
			await plane.create({ host: site, bundle: '/srv/bundles/e2e.tar', probe: '/health' });
			expect((await plane.list()).map((row) => row.name)).toEqual([site]);

			const first = await plane.upload(site, buildFor('one'));
			const second = await plane.upload(site, buildFor('two'));
			expect(second.versionId).not.toBe(first.versionId);
			// the id is the content address, so it is also what tells a redeploy from a new one
			expect(second.etag).toBe(second.versionId);

			const firstId = String(first.versionId);
			const versions = await plane.versions(site);
			expect(versions.map((version) => version.id)).toContain(firstId);

			const rollout = await plane.rollout(site, firstId, 10);
			expect(rollout.split).toEqual({ version: firstId, percent: 10 });

			const back = await plane.rollback(site);
			expect(back.current).toBe(firstId);
		} finally {
			await node.close();
		}
	});

	it('refuses a deploy to a site the node does not have', async () => {
		const node = await startLocalNode();
		const plane = workerd({ endpoint: node.endpoint, token: node.token });
		try {
			await expect(plane.upload('wf-e2e-absent.example', buildFor('x'))).rejects.toThrow(
				/not found/
			);
		} finally {
			await node.close();
		}
	});

	it('fails a wrong token rather than answering an empty fleet', async () => {
		const node = await startLocalNode();
		const plane = workerd({ endpoint: node.endpoint, token: 'bst_wrong' });
		try {
			await expect(plane.list()).rejects.toThrow(/rejected the token/);
			expect(node.state.log.at(-1)?.authorized).toBe(false);
		} finally {
			await node.close();
		}
	});
});
