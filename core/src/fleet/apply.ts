/**
 * Executing a plan, resumably.
 *
 * The cursor is handed back rather than stored, which is `provisionLane`'s shape in
 * `drupflare/worker`: an abandoned run leaves nothing to clean up, and a resumed one needs no
 * reconciliation with a half-written record of its own progress. It carries one state per action,
 * so a caller that persists it from `onTransition` resumes where the executor stopped.
 */

import type { Budget } from '../client/budget.js';
import { UsageError } from '../client/errors.js';
import { mapFleet, type MapOptions } from './map.js';
import type { FleetPlan, PlannedAction } from './plan.js';

export type ActionState = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ApplyCursor {
	/** digest of the plan these states belong to; a cursor only resumes that plan */
	digest: string;
	/** one state per action that is not unchanged, in plan order */
	states: ActionState[];
}

export interface ApplyOptions extends MapOptions {
	cursor?: ApplyCursor;
	/** how many actions to start before handing a cursor back */
	budgetActions?: number;
	budget?: Budget;
	/**
	 * Called with a copy of the cursor after every state change, so a caller can persist it.
	 *
	 * A throw stops the apply and rejects with that error, as a failed durable write would.
	 */
	onTransition?: (cursor: ApplyCursor) => void | Promise<void>;
}

export interface ApplyReport {
	/** workers that succeeded in this call */
	applied: string[];
	/** workers that failed in this call; a resumed apply tries them again */
	failed: { worker: string; error: unknown }[];
	skipped: string[];
	/** every action has succeeded; a failure or an unreached action leaves this false */
	done: boolean;
	/** absent when done, so a finished apply cannot be resumed by accident */
	cursor?: ApplyCursor;
}

export type ActionRunner = (action: PlannedAction) => Promise<void>;

/**
 * Applies a plan.
 *
 * Unchanged actions are counted as skipped rather than applied, so a report that says "applied 400"
 * on a fleet where nothing changed is not something this can produce.
 *
 * A `running` action found in a cursor runs again: the executor died inside it, and the cursor
 * cannot say whether its side effect landed. The runner has to be safe to repeat for that window.
 */
export async function applyPlan(
	plan: FleetPlan,
	run: ActionRunner,
	options: ApplyOptions = {}
): Promise<ApplyReport> {
	const actionable = plan.actions.filter((a) => a.kind !== 'unchanged');
	const skipped = plan.actions.filter((a) => a.kind === 'unchanged').map((a) => a.worker);
	const digest = await digestOf(plan);
	if (options.cursor !== undefined && options.cursor.digest !== digest) {
		throw new UsageError(
			'this cursor belongs to a different plan; start the apply again from this one'
		);
	}

	const states: ActionState[] = options.cursor?.states.slice() ?? actionable.map(() => 'pending');
	const pending = actionable.map((_, i) => i).filter((i) => states[i] !== 'succeeded');
	const batch = pending.slice(0, options.budgetActions ?? pending.length);

	let stopped: { error: unknown } | undefined;
	const transition = async (i: number, state: ActionState): Promise<void> => {
		states[i] = state;
		try {
			await options.onTransition?.({ digest, states: states.slice() });
		} catch (error) {
			if (stopped === undefined) stopped = { error };
			throw error;
		}
	};
	const workerOf = (i: number): string => (actionable[i] as PlannedAction).worker;

	const result = await mapFleet(
		batch,
		async (i) => {
			if (stopped !== undefined) return;
			await transition(i, 'running');
			try {
				await run(actionable[i] as PlannedAction);
			} catch (error) {
				await transition(i, 'failed');
				throw error;
			}
			await transition(i, 'succeeded');
		},
		options
	);
	if (stopped !== undefined) throw stopped.error;

	const done = states.every((state) => state === 'succeeded');
	const report: ApplyReport = {
		applied: result.succeeded.map((o) => workerOf(o.item)),
		failed: result.failed.map((o) => ({ worker: workerOf(o.item), error: o.error })),
		skipped,
		done
	};
	return done ? report : { ...report, cursor: { digest, states } };
}

/** a SHA-256 over the plan's actions, so a cursor cannot be replayed against an edited plan */
async function digestOf(plan: FleetPlan): Promise<string> {
	const text = JSON.stringify(
		plan.actions.map((a) => [a.kind, a.worker, a.changes, a.desired ?? null])
	);
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
