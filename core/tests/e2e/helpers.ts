/**
 * Which e2e mode this run is in, and the skips that say so out loud.
 *
 * `drupflare/worker`'s config lane prints what it dropped and how to get it back rather than quietly
 * running less, because a lane that skips silently reads exactly like a lane that passed.
 *
 * **A rate limit skips; a bad credential fails.** The free account this runs against is a throwaway,
 * and several pushes in a day can cross the 1,200-per-five-minutes limit, which is expected and not
 * actionable. An expired or wrong token is actionable, so it has to fail rather than disappear into
 * a green run.
 */

import { cloudflare, LimitError, workforce, type Workforce } from '../../src/index.js';
import {
	LOCAL_ACCOUNT,
	startLocalPlane,
	type LocalPlane,
	type PlaneOptions
} from './server/index.js';

export const INTEGRATION = process.env.WORKFORCE_E2E_INTEGRATION === '1';

export const FREE_ACCOUNT = process.env.FREE_CLOUDFLARE_ACCOUNT_ID ?? '';
export const FREE_TOKEN = process.env.FREE_CLOUDFLARE_API_TOKEN ?? '';

/** every worker this lane creates, so a leak is visible and a teardown is exhaustive */
export const PREFIX = 'wf-e2e-';

export function integrationReady(): boolean {
	return INTEGRATION && FREE_ACCOUNT !== '' && FREE_TOKEN !== '';
}

/** the reason this lane is not running, printed rather than swallowed */
export function skipReason(): string | null {
	if (!INTEGRATION) return null;
	if (FREE_ACCOUNT === '' || FREE_TOKEN === '') {
		return 'the integration lane needs FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN; set both and re-run `bun run test:e2e:integration`';
	}
	return null;
}

export function announceSkip(what: string): void {
	const reason = skipReason();
	if (reason !== null) console.warn(`[e2e] skipping ${what}: ${reason}`);
}

/** whether this failure is the account being out of API budget rather than anything wrong */
export function isRateLimited(error: unknown): boolean {
	if (error instanceof LimitError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /rate limit|too many requests|\b429\b|blocked until this window/i.test(message);
}

export interface Reachability {
	ok: boolean;
	/** set when the lane should skip rather than fail */
	skip: string | null;
}

/**
 * One cheap call, to decide whether this run can do anything.
 *
 * A rate limit answers `skip`; anything else propagates, because a wrong credential that silently
 * skipped would leave the lane green while testing nothing.
 */
export async function probeIntegration(): Promise<Reachability> {
	if (!integrationReady()) return { ok: false, skip: skipReason() };
	const client = workforce({
		plane: cloudflare({ accountId: FREE_ACCOUNT, token: FREE_TOKEN, retries: 0 })
	});
	try {
		await client.plane.list({ limit: 1 });
		return { ok: true, skip: null };
	} catch (error) {
		if (isRateLimited(error)) {
			return {
				ok: false,
				skip: `the account is out of API budget for this window (${error instanceof Error ? error.message : String(error)}); this is expected on a busy day and is not a failure`
			};
		}
		throw error;
	}
}

export interface Harness {
	client: Workforce;
	local: LocalPlane | null;
	/** a name in this lane's namespace, so teardown can find everything it made */
	name(suffix: string): string;
	close(): Promise<void>;
}

/**
 * One harness for both modes.
 *
 * The same specs run against the local plane and against Cloudflare, which is what keeps the local
 * one honest: a behaviour it gets wrong shows up as a pass here and a failure there. That has already
 * happened twice, and both were real bugs.
 */
export async function harness(options: PlaneOptions = {}): Promise<Harness> {
	if (integrationReady()) {
		const client = workforce({
			plane: cloudflare({ accountId: FREE_ACCOUNT, token: FREE_TOKEN })
		});
		return {
			client,
			local: null,
			name: (suffix) => `${PREFIX}${suffix}`,
			close: async () => {}
		};
	}

	const local = await startLocalPlane(options);
	const client = workforce({
		plane: cloudflare({
			accountId: LOCAL_ACCOUNT,
			token: 'local-token',
			baseUrl: local.baseUrl
		})
	});
	return {
		client,
		local,
		name: (suffix) => `${PREFIX}${suffix}`,
		close: () => local.close()
	};
}

/**
 * Runs the body, skipping rather than failing when the account is out of budget.
 *
 * Wraps the assertions of an integration spec so one rate-limited call does not turn a whole CI run
 * red for a reason nobody can act on.
 */
export async function tolerateRateLimit(what: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} catch (error) {
		if (INTEGRATION && isRateLimited(error)) {
			console.warn(`[e2e] skipped ${what}: out of API budget for this window`);
			return;
		}
		throw error;
	}
}
