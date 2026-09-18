/**
 * The rate governor.
 *
 * Cloudflare allows 1,200 requests per five minutes PER USER, counted across the dashboard, API keys
 * and every token together. Crossing it blocks every call for the next five minutes, including the
 * dashboard's, so this is a cliff rather than a gradient and a fleet job that ignores it locks its
 * owner out of their own account.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/limits/
 */

import { LimitError } from './errors.js';

/** what a response said about the budget, as far as its headers could be read */
export interface RateReading {
	/** requests left in the current window */
	remaining: number | null;
	/** seconds until the window resets */
	resetSeconds: number | null;
	/** the window's total allowance */
	quota: number | null;
	/** the window's length in seconds */
	windowSeconds: number | null;
}

export interface BudgetOptions {
	/**
	 * Stop spending once this fraction of the window's allowance remains.
	 *
	 * A judgement rather than a measurement: it leaves room for a human on the dashboard while a
	 * fleet job runs. Set it to 0 to spend the whole allowance.
	 */
	reserve?: number;
	/** how many requests may be in flight at once */
	concurrency?: number;
	/** the assumed allowance before any response has reported one */
	assumedQuota?: number;
	/** the assumed window before any response has reported one */
	assumedWindowSeconds?: number;
	/** injectable so tests do not wait in real time */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RESERVE = 0.2;
export const DEFAULT_CONCURRENCY = 6;
export const ASSUMED_QUOTA = 1200;
export const ASSUMED_WINDOW_SECONDS = 300;

const NUMBER = /-?\d+(?:\.\d+)?/;

/**
 * Reads one parameter out of a RateLimit header.
 *
 * Parsed loosely on purpose. The header is an IETF draft whose spelling has moved, and implementations
 * differ on quoting and on whether the policy name comes first, so anchoring on `key=value` survives a
 * revision where anchoring on the whole grammar does not.
 */
export function readRateParam(header: string | null, key: string): number | null {
	if (header === null) return null;
	const at = new RegExp(`(?:^|[;,\\s])${key}\\s*=\\s*"?(${NUMBER.source})`, 'i').exec(header);
	if (at === null) return null;
	const value = Number(at[1]);
	return Number.isFinite(value) ? value : null;
}

/** Reads what a response says about the budget. Every field is independently optional. */
export function readRateHeaders(headers: Headers): RateReading {
	const limit = headers.get('ratelimit');
	const policy = headers.get('ratelimit-policy');
	return {
		remaining: readRateParam(limit, 'r'),
		resetSeconds: readRateParam(limit, 't'),
		quota: readRateParam(policy, 'q'),
		windowSeconds: readRateParam(policy, 'w')
	};
}

/**
 * Reads `Retry-After`, which is either a delay in seconds or an HTTP date.
 *
 * Returns null when absent, and null is not zero: a caller that retries immediately on null turns one
 * 429 into the thing that keeps the account locked out.
 */
export function readRetryAfter(headers: Headers, nowMs: number): number | null {
	const raw = headers.get('retry-after');
	if (raw === null) return null;
	const seconds = Number(raw.trim());
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const at = Date.parse(raw);
	if (Number.isNaN(at)) return null;
	return Math.max(0, at - nowMs);
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One credential's share of the API.
 *
 * Keyed by CREDENTIAL rather than by account: two accounts reached with one token share a budget,
 * because the limit counts the user. Two tokens cannot be proven to belong to one user from outside,
 * so the default is one budget per token, which is conservative and right whenever a user holds one.
 */
export class Budget {
	readonly reserve: number;
	readonly concurrency: number;

	private quota: number;
	private windowSeconds: number;
	private remaining: number;
	private windowEndsAtMs: number;
	private inFlight = 0;
	private waiters: (() => void)[] = [];
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: BudgetOptions = {}) {
		this.reserve = options.reserve ?? DEFAULT_RESERVE;
		this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
		this.quota = options.assumedQuota ?? ASSUMED_QUOTA;
		this.windowSeconds = options.assumedWindowSeconds ?? ASSUMED_WINDOW_SECONDS;
		this.remaining = this.quota;
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? defaultSleep;
		this.windowEndsAtMs = this.now() + this.windowSeconds * 1000;
	}

	/** what the governor currently believes, for a status line or a test */
	snapshot(): { remaining: number; quota: number; floor: number; resetsInMs: number } {
		this.rollWindow();
		return {
			remaining: this.remaining,
			quota: this.quota,
			floor: this.floor(),
			resetsInMs: Math.max(0, this.windowEndsAtMs - this.now())
		};
	}

	/** the number of requests this budget will not spend */
	floor(): number {
		return Math.ceil(this.quota * this.reserve);
	}

	private rollWindow(): void {
		if (this.now() < this.windowEndsAtMs) return;
		this.remaining = this.quota;
		this.windowEndsAtMs = this.now() + this.windowSeconds * 1000;
	}

	/**
	 * Waits until one request may be spent.
	 *
	 * Blocks on two things: the concurrency cap, and the reserve. Crossing the reserve waits for the
	 * window to roll rather than throwing, because a fleet operation that is merely slow is a better
	 * outcome than one that half-applied and stopped.
	 */
	async acquire(): Promise<void> {
		for (;;) {
			this.rollWindow();
			if (this.inFlight < this.concurrency && this.remaining > this.floor()) {
				this.inFlight += 1;
				this.remaining -= 1;
				return;
			}
			if (this.remaining <= this.floor()) {
				const wait = Math.max(1, this.windowEndsAtMs - this.now());
				await this.sleep(wait);
				continue;
			}
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
	}

	/** returns the slot; the spend itself is not returned, because the API counted it */
	release(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		const next = this.waiters.shift();
		if (next !== undefined) next();
	}

	/**
	 * Folds a response's own headers in, which is what makes this track reality.
	 *
	 * The server's count wins over the local one whenever it reports one, since the local count cannot
	 * see the dashboard or another process holding the same token.
	 */
	observe(headers: Headers): void {
		const reading = readRateHeaders(headers);
		if (reading.quota !== null && reading.quota > 0) this.quota = reading.quota;
		if (reading.windowSeconds !== null && reading.windowSeconds > 0) {
			this.windowSeconds = reading.windowSeconds;
		}
		if (reading.remaining !== null) this.remaining = reading.remaining;
		if (reading.resetSeconds !== null) {
			this.windowEndsAtMs = this.now() + reading.resetSeconds * 1000;
		}
	}

	/** treats a 429 as authoritative: the window is spent until it says otherwise */
	penalise(headers: Headers): number {
		const wait = readRetryAfter(headers, this.now()) ?? this.windowSeconds * 1000;
		this.remaining = 0;
		this.windowEndsAtMs = this.now() + wait;
		return wait;
	}

	/** refuses rather than waiting, for a caller that would rather fail fast */
	assertAvailable(): void {
		this.rollWindow();
		if (this.remaining <= this.floor()) {
			throw new LimitError(
				`the API budget is down to ${this.remaining} of ${this.quota} and the reserve holds ${this.floor()} back`,
				Math.max(0, this.windowEndsAtMs - this.now())
			);
		}
	}
}

/**
 * Budgets shared by credential.
 *
 * A hub holding several planes on one token gets one governor for all of them, which is the whole
 * reason this is a registry rather than a field on the client.
 */
export class BudgetRegistry {
	private readonly budgets = new Map<string, Budget>();

	constructor(private readonly options: BudgetOptions = {}) {}

	for(key: string): Budget {
		const existing = this.budgets.get(key);
		if (existing !== undefined) return existing;
		const created = new Budget(this.options);
		this.budgets.set(key, created);
		return created;
	}
}
