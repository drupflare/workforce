/**
 * The upload has to produce something that runs.
 *
 * Every other spec asserts on state the plane reported back, which a mock can satisfy by agreeing
 * with itself. This one boots the uploaded modules under a real `wrangler dev` and asks the worker a
 * question, so a multipart body that is subtly wrong fails here rather than on a deploy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromFiles } from '../../src/index.js';
import { harness, INTEGRATION, type Harness } from './helpers.js';
import { wranglerAvailable } from './server/wrangler.js';

const available = !INTEGRATION && (await wranglerAvailable());
if (!INTEGRATION && !available) {
	console.warn(
		'[e2e] skipping the running-worker suite: wrangler is not on PATH. Run `bun install` in core/, or `bunx wrangler --version` to check.'
	);
}

describe.skipIf(!available)('an uploaded worker answers', () => {
	let h: Harness;
	const name = 'wf-e2e-answers';

	beforeAll(async () => {
		h = await harness({ runWorkers: true });
	}, 120_000);

	afterAll(async () => {
		await h?.close();
	});

	it('serves the module set it was given', async () => {
		await h.client.worker(name).upload({
			source: fromFiles({
				'index.js':
					'export default { fetch: () => new Response("workforce-ok", { headers: { "x-from": "upload" } }) };'
			}),
			metadata: { compatibility_date: '2026-08-01' }
		});

		const url = h.local?.workerUrl(name);
		expect(
			url,
			'the local plane should have started a dev server for this worker'
		).not.toBeNull();

		const response = await fetch(url as string);
		expect(await response.text()).toBe('workforce-ok');
		expect(response.headers.get('x-from')).toBe('upload');
	}, 120_000);

	it('serves a bundle whose entry point imports another module', async () => {
		const multi = 'wf-e2e-answers-multi';
		await h.client.worker(multi).upload({
			source: fromFiles({
				'index.js':
					'import { body } from "./lib/text.js";\nexport default { fetch: () => new Response(body) };',
				'lib/text.js': 'export const body = "from-a-nested-module";'
			}),
			main: 'index.js',
			metadata: { compatibility_date: '2026-08-01' }
		});

		const url = h.local?.workerUrl(multi);
		expect(url, 'a multi-module bundle should have started too').not.toBeNull();
		// this is the assertion the part naming exists for: renaming module parts breaks the import
		expect(await (await fetch(url as string)).text()).toBe('from-a-nested-module');
	}, 120_000);
});
