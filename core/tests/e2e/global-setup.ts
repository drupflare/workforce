/**
 * Says, once and visibly, what this run is about to do.
 *
 * A module-level `console.warn` inside a spec is swallowed: vitest does not surface output written
 * during collection, so a suite that skipped looked exactly like a suite that passed. Global setup
 * runs outside collection and its output is shown, which is what makes the skip legible.
 *
 * `drupflare/worker`'s config lane has the same rule for the same reason: print what was dropped and
 * how to get it back, never a quiet reduction in coverage.
 */

import { FREE_ACCOUNT, INTEGRATION, probeIntegration } from './helpers.js';
import { wranglerAvailable } from './server/wrangler.js';

export async function setup(): Promise<void> {
	const lines: string[] = [];

	if (!INTEGRATION) {
		lines.push('[e2e] mode: local plane (wrangler dev).');
		if (!(await wranglerAvailable())) {
			lines.push(
				'[e2e] wrangler is NOT on PATH, so the specs that boot a real Worker will skip.',
				'[e2e]   fix: run `bun install` in core/, then `bunx wrangler --version` to confirm.'
			);
		}
	} else {
		const gate = await probeIntegration();
		if (gate.ok) {
			lines.push(
				`[e2e] mode: integration against Cloudflare account ${FREE_ACCOUNT.slice(0, 8)}…`
			);
		} else {
			lines.push(
				'[e2e] mode: integration, but the suites that need Cloudflare are SKIPPED.',
				`[e2e]   reason: ${gate.skip ?? 'unknown'}`,
				'[e2e]   to run them: set FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN,',
				'[e2e]   then `bun run test:e2e:integration`.'
			);
		}
	}

	for (const line of lines) console.log(line);
}
