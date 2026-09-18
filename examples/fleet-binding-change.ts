/**
 * Change one binding across a whole fleet, inside the request budget.
 *
 * ```sh
 * CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun examples/fleet-binding-change.ts
 * ```
 */

import { cloudflare, mapFleet, workforce } from '../core/src/index.js';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
if (accountId === '' || token === '') {
	throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
}

const cf = workforce({ plane: cloudflare({ accountId, token }) });
const workers = await cf.list();
console.log(`${workers.length} worker(s) on this account`);

const result = await mapFleet(
	workers,
	async (worker) => {
		// patchSettings reads the current bindings first, so the rest are inherited rather than lost
		await worker.patchSettings({
			bindings: [{ type: 'plain_text', name: 'FLEET_MARKER', text: 'set-by-workforce' }]
		});
	},
	{
		concurrency: 4,
		onProgress: (done, total) => console.log(`${done}/${total}`)
	}
);

console.log(`changed ${result.succeeded.length}, failed ${result.failed.length}`);
for (const failure of result.failed) {
	console.error(`${failure.item.name}: ${String(failure.error)}`);
}
