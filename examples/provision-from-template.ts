/**
 * Provision a Worker from a GitHub template.
 *
 * ```sh
 * CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun examples/provision-from-template.ts
 * ```
 */

import { cloudflare, fromGitHub, workforce } from '../core/src/index.js';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
if (accountId === '' || token === '') {
	throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
}

const cf = workforce({ plane: cloudflare({ accountId, token }) });

const source = await fromGitHub('cloudflare/workers-sdk', {
	ref: 'main',
	filter: (path) => path === 'package.json'
});

console.log(`the template carries ${source.size} file(s) after filtering`);

// upload it here, once the filter selects a real Worker entry point
