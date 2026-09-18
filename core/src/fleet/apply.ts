/**
 * Executing a plan, resumably.
 *
 * The cursor is handed back rather than stored, which is `provisionLane`'s shape in
 * `drupflare/worker`: an abandoned run leaves nothing to clean up, and a resumed one needs no
 * reconciliation with a half-written record of its own progress.
 */

import type { Budget } from '../client/budget.js';
import { mapFleet, type MapOptions } from './map.js';
import type { FleetPlan, PlannedAction } from './plan.js';

export interface ApplyCursor {
	/** index into the plan's action list */
	index: number;
}

export interface ApplyOptions extends MapOptions {
	cursor?: ApplyCursor;
	/** how many actions to perform before handing a cursor back */
	budgetActions?: number;
	budget?: Budget;
}

export interface ApplyReport {
	applied: string[];
	failed: { worker: string; error: unknown }[];
	skipped: string[];
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
 */
export async function applyPlan(
	plan: FleetPlan,
	run: ActionRunner,
	options: ApplyOptions = {}
): Promise<ApplyReport> {
	const actionable = plan.actions.filter((a) => a.kind !== 'unchanged');
	const skipped = plan.actions.filter((a) => a.kind === 'unchanged').map((a) => a.worker);

	const start = options.cursor?.index ?? 0;
	const limit = options.budgetActions ?? actionable.length;
	const slice = actionable.slice(start, start + limit);

	const result = await mapFleet(slice, async (action) => run(action), options);

	const end = start + slice.length;
	const done = end >= actionable.length;
	const report: ApplyReport = {
		applied: result.succeeded.map((o) => o.item.worker),
		failed: result.failed.map((o) => ({ worker: o.item.worker, error: o.error })),
		skipped,
		done
	};
	return done ? report : { ...report, cursor: { index: end } };
}
