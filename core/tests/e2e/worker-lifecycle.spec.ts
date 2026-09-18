import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromFiles } from '../../src/index.js';
import { harness, INTEGRATION, probeIntegration, type Harness } from './helpers.js';

const gate = await probeIntegration();
const run = !INTEGRATION || gate.ok;
if (!run)
	console.warn('[e2e] skipping the worker lifecycle suite: ' + (gate.skip ?? 'not configured'));

describe.skipIf(!run)('a worker, end to end', () => {
	let h: Harness;
	const name = `wf-e2e-lifecycle-${Date.now().toString(36)}`;

	beforeAll(async () => {
		h = await harness();
	});

	afterAll(async () => {
		await h.client
			.worker(name)
			.delete()
			.catch(() => {});
		await h.close();
	});

	it('does not exist before it is made', async () => {
		expect(await h.client.worker(name).exists()).toBe(false);
	});

	it('uploads and then exists', async () => {
		await h.client.worker(name).upload({
			source: fromFiles({
				'index.js': 'export default { fetch: () => new Response("hello from workforce") };'
			}),
			metadata: { compatibility_date: '2026-08-01' }
		});
		expect(await h.client.worker(name).exists()).toBe(true);
	});

	it('appears in the account listing', async () => {
		const names = (await h.client.list()).map((w) => w.name);
		expect(names).toContain(name);
	});

	it('reads back the settings it was uploaded with', async () => {
		const settings = await h.client.worker(name).settings();
		expect(settings.compatibilityDate).toBe('2026-08-01');
	});

	it('patches settings without dropping what it did not mention', async () => {
		await h.client.worker(name).patchSettings({
			bindings: [{ type: 'plain_text', name: 'GREETING', text: 'hi' }]
		});
		const settings = await h.client.worker(name).settings();
		expect(settings.bindings.some((b) => b.name === 'GREETING')).toBe(true);
	});

	it('stores a secret and lists it without the value', async () => {
		await h.client.worker(name).secrets.put('API_KEY', 'shh');
		const secrets = await h.client.worker(name).secrets.list();
		const found = secrets.find((s) => s.name === 'API_KEY');
		expect(found?.type).toBe('secret_text');
		expect(JSON.stringify(found)).not.toContain('shh');
	});

	it('deletes, and then no longer exists', async () => {
		await h.client.worker(name).delete();
		expect(await h.client.worker(name).exists()).toBe(false);
	});
});
