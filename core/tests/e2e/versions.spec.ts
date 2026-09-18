/**
 * Versions and deployments against a plane that refuses what Cloudflare refuses.
 *
 * The local plane reproduces the documented rejections rather than accepting everything, so the
 * guards are measured against a behaviour instead of against a mock of themselves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildUpload, fromFiles } from '../../src/index.js';
import { harness, INTEGRATION, probeIntegration, type Harness } from './helpers.js';

const gate = await probeIntegration();
const run = !INTEGRATION || gate.ok;
if (!run) console.warn('[e2e] skipping the versions suite: ' + (gate.skip ?? 'not configured'));

const worker = (body: string) =>
	fromFiles({
		'index.js': `export default { fetch: () => new Response(${JSON.stringify(body)}) };`
	});

describe.skipIf(!run)('versions and deployments', () => {
	let h: Harness;
	const name = `wf-e2e-versions-${Date.now().toString(36)}`;

	beforeAll(async () => {
		h = await harness();
		await h.client
			.worker(name)
			.upload({ source: worker('one'), metadata: { compatibility_date: '2026-08-01' } });
	});

	afterAll(async () => {
		await h.client
			.worker(name)
			.delete()
			.catch(() => {});
		await h.close();
	});

	it('lists the version the first upload produced', async () => {
		const versions = await h.client.worker(name).versions.list();
		expect(versions.length).toBeGreaterThan(0);
		expect(versions[0]?.id).toBeTruthy();
	});

	it('creates a version without deploying it', async () => {
		const before = await h.client.worker(name).versions.deployments();
		const created = await h.client.worker(name).versions.create({
			upload: buildUpload({
				source: worker('two'),
				metadata: { compatibility_date: '2026-08-01' }
			}),
			message: 'the second one'
		});
		expect(created.id).toBeTruthy();
		const after = await h.client.worker(name).versions.deployments();
		expect(after.length).toBe(before.length);
	});

	it('carries the message into the version annotations', async () => {
		const versions = await h.client.worker(name).versions.list();
		expect(versions.some((v) => v.message === 'the second one')).toBe(true);
	});

	it('deploys a version at 100 percent', async () => {
		const versions = await h.client.worker(name).versions.list();
		const target = versions[0]?.id as string;
		const deployment = await h.client.worker(name).versions.deploy(target);
		expect(deployment.versions[0]?.version).toBe(target);
	});

	it('splits traffic across two versions', async () => {
		const versions = await h.client.worker(name).versions.list();
		const [next, current] = [versions[0]?.id as string, versions[1]?.id as string];
		const deployment = await h.client.worker(name).versions.deploy([
			{ version: next, percentage: 10 },
			{ version: current, percentage: 90 }
		]);
		expect(deployment.versions.map((v) => v.percentage)).toEqual([10, 90]);
	});

	it('rolls back to an earlier version without creating a new one', async () => {
		const before = await h.client.worker(name).versions.list();
		const target = before[before.length - 1]?.id as string;
		await h.client.worker(name).versions.rollback(target);
		const after = await h.client.worker(name).versions.list();
		expect(after.length).toBe(before.length);
	});

	it('is refused by the plane when a version carries a lifecycle change', async () => {
		// the guard normally catches this first, so go around it to prove the plane refuses too
		const upload = buildUpload({
			source: worker('three'),
			metadata: { compatibility_date: '2026-08-01' }
		});
		const metadata = JSON.parse(upload.body.get('metadata') as string) as Record<
			string,
			unknown
		>;
		upload.body.set(
			'metadata',
			JSON.stringify({
				...metadata,
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		);
		await expect(
			h.client.plane.http.request(
				`/accounts/${(h.client.plane as unknown as { accountId: string }).accountId}/workers/scripts/${name}/versions`,
				{ method: 'POST', body: upload.body }
			)
		).rejects.toThrow(/migration|lifecycle/i);
	});

	it('refuses the same thing in the client, before spending a request', async () => {
		await expect(
			h.client.worker(name).versions.create({
				upload: buildUpload({
					source: worker('four'),
					metadata: {
						compatibility_date: '2026-08-01',
						migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
					}
				})
			})
		).rejects.toThrow(/lifecycle/);
	});
});
