/**
 * Doing one thing to many workers, inside the budget.
 *
 * The governor already paces individual requests; this is the layer that decides how many operations
 * are in flight and what happens when one of them fails. A fleet operation that stops at the first
 * error leaves the fleet half-changed, so the default is to finish and report, not to abort.
 */

import type { Budget } from '../client/budget.js';

export interface MapOptions {
	/** how many operations run at once; the budget still paces the requests inside them */
	concurrency?: number;
	/** stop at the first failure instead of finishing and reporting */
	failFast?: boolean;
	/** called as each one finishes, for a progress line */
	onProgress?: (done: number, total: number) => void;
	budget?: Budget;
}

export interface MapOutcome<T, R> {
	item: T;
	/** whether this item ran at all; a void-returning fn makes `result` useless for deciding that */
	attempted: boolean;
	result?: R;
	error?: unknown;
}

export interface MapResult<T, R> {
	outcomes: MapOutcome<T, R>[];
	succeeded: MapOutcome<T, R>[];
	failed: MapOutcome<T, R>[];
	get ok(): boolean;
}

/**
 * Runs `fn` over `items` with bounded concurrency.
 *
 * Order of results follows the input rather than completion, because a caller reading a report wants
 * it to line up with what they asked for.
 */
export async function mapFleet<T, R>(
	items: readonly T[],
	fn: (item: T, index: number) => Promise<R>,
	options: MapOptions = {}
): Promise<MapResult<T, R>> {
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const outcomes: MapOutcome<T, R>[] = items.map((item) => ({ item, attempted: false }));
	let next = 0;
	let done = 0;
	let aborted = false;

	async function worker(): Promise<void> {
		for (;;) {
			if (aborted) return;
			const at = next;
			next += 1;
			if (at >= items.length) return;
			const item = items[at] as T;
			const outcome = outcomes[at] as MapOutcome<T, R>;
			outcome.attempted = true;
			try {
				outcome.result = await fn(item, at);
			} catch (error) {
				outcome.error = error;
				if (options.failFast === true) aborted = true;
			}
			done += 1;
			options.onProgress?.(done, items.length);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

	const attempted = outcomes.filter((outcome) => outcome.attempted);
	const failed = attempted.filter((outcome) => outcome.error !== undefined);
	return {
		outcomes,
		succeeded: attempted.filter((outcome) => outcome.error === undefined),
		failed,
		get ok() {
			return failed.length === 0;
		}
	};
}
