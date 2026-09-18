/**
 * A Worker that provisions another Worker from its own assets.
 *
 * Deploy this as a Worker with an ASSETS binding holding a template and a manifest. Nothing here
 * touches a filesystem, which is what makes it run on the Workers runtime.
 */

import { cloudflare, fromAssets, workforce, type AssetsBinding } from '../core/src/index.js';

interface Env {
	ASSETS: AssetsBinding;
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const name = new URL(request.url).searchParams.get('name');
		if (name === null) return new Response('pass ?name=', { status: 400 });

		// one subrequest per file, bounded so the invocation keeps headroom for everything else
		const source = await fromAssets(env.ASSETS, '/template/manifest.json', { budget: 40 });
		if (!source.done) {
			return Response.json({
				provisioned: false,
				resumeFrom: source.cursor,
				reason: 'the subrequest budget ran out; call again with this cursor'
			});
		}

		const cf = workforce({
			plane: cloudflare({
				accountId: env.CLOUDFLARE_ACCOUNT_ID,
				token: env.CLOUDFLARE_API_TOKEN
			})
		});

		const result = await cf.worker(name).upload({
			source: source.modules,
			metadata: { compatibility_date: '2026-08-01' }
		});

		return Response.json({ provisioned: true, etag: result.etag, missing: source.missing });
	}
};
