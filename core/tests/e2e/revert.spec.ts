/**
 * `revert` moves history forward; `rollback` does not.
 *
 * The distinction is the reason both exist, so it is asserted against a plane that actually keeps a
 * version list rather than against a mock that agrees with whatever it is told.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromFiles, planRevert, RevisionStore, toUtf8 } from '../../src/index.js';
import { memoryStore } from '../../src/store/index.js';
import { harness, INTEGRATION, probeIntegration, type Harness } from './helpers.js';

const gate = await probeIntegration();
const run = !INTEGRATION || gate.ok;
if (!run) console.warn('[e2e] skipping the revert suite: ' + (gate.skip ?? 'not configured'));

const worker = (body: string) =>
	fromFiles({
		'index.js': `export default { fetch: () => new Response(${JSON.stringify(body)}) };`
	});

describe.skipIf(!run)('revert against rollback', () => {
	let h: Harness;
	const name = `wf-e2e-revert-${Date.now().toString(36)}`;
	const store = memoryStore();
	const revisions = new RevisionStore(store);
	let firstRevision = '';

	beforeAll(async () => {
		h = await harness();
		const first = worker('the-first-one');
		const upload = await h.client
			.worker(name)
			.upload({ source: first, metadata: { compatibility_date: '2026-08-01' } });
		const written = await revisions.write(name, first, {
			versionId: upload.versionId,
			etag: upload.etag,
			label: 'first'
		});
		firstRevision = written.revision.id;

		await h.client.worker(name).upload({
			source: worker('the-second-one'),
			metadata: { compatibility_date: '2026-08-01' }
		});
	});

	afterAll(async () => {
		await h.client
			.worker(name)
			.delete()
			.catch(() => {});
		await h.close();
	});

	it('rebuilds the old content from the store, which the platform cannot return', async () => {
		const plan = await planRevert(revisions, name, firstRevision);
		expect(toUtf8(plan.modules.get('index.js') as Uint8Array)).toContain('the-first-one');
	});

	it('revert adds a version rather than re-pointing at an old one', async () => {
		const before = await h.client.worker(name).versions.list();
		const plan = await planRevert(revisions, name, firstRevision);
		await h.client.worker(name).versions.create({ upload: plan.upload, message: plan.message });
		const after = await h.client.worker(name).versions.list();
		expect(after.length).toBe(before.length + 1);
		expect(after[0]?.message).toMatch(/^revert to /);
	});

	it('rollback re-points without adding one', async () => {
		const before = await h.client.worker(name).versions.list();
		const target = before[before.length - 1]?.id as string;
		await h.client.worker(name).versions.rollback(target);
		const after = await h.client.worker(name).versions.list();
		expect(after.length).toBe(before.length);
	});

	it('refuses a revert for content the store never held', async () => {
		await expect(planRevert(revisions, name, 'not-a-revision')).rejects.toThrow(
			/cannot return an old version/
		);
	});

	it('marks a version workforce did not create as content-unavailable', async () => {
		// this upload goes straight to the plane with nothing written to the store
		await h.client.worker(name).upload({
			source: worker('out-of-band'),
			metadata: { compatibility_date: '2026-08-01' }
		});
		const versions = await h.client.worker(name).versions.list();
		const foreign = versions[0]?.id as string;
		expect(await revisions.byVersion(name, foreign)).toBeNull();
	});
});
