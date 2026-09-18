/**
 * Desired against actual, as a plan a caller can read before anything happens.
 *
 * A fleet change that only reports what it did is one you have to run to understand. A plan is the
 * same computation with the acting half removed, which is what makes a dry run meaningful rather than
 * decorative.
 */

import type { InventoryRecord } from './inventory.js';

export type ActionKind = 'create' | 'update' | 'delete' | 'unchanged';

export interface PlannedAction {
	kind: ActionKind;
	worker: string;
	/** what differs, for a caller rendering the plan */
	changes: string[];
	desired?: InventoryRecord;
	actual?: InventoryRecord;
}

export interface FleetPlan {
	actions: PlannedAction[];
	create: PlannedAction[];
	update: PlannedAction[];
	remove: PlannedAction[];
	unchanged: PlannedAction[];
	get empty(): boolean;
}

function differences(desired: InventoryRecord, actual: InventoryRecord): string[] {
	const changes: string[] = [];
	if (desired.env !== actual.env) changes.push(`env ${actual.env} -> ${desired.env}`);
	if (desired.owner !== actual.owner) changes.push(`owner ${actual.owner} -> ${desired.owner}`);
	if (desired.revision !== actual.revision) {
		changes.push(`revision ${actual.revision} -> ${desired.revision}`);
	}
	if (desired.ttlAtMs !== actual.ttlAtMs)
		changes.push(`ttl ${actual.ttlAtMs} -> ${desired.ttlAtMs}`);
	return changes;
}

export interface PlanOptions {
	/**
	 * Remove workers that are present but not desired.
	 *
	 * Off by default, and deliberately: a caller who lists a subset of their fleet should not have
	 * the rest deleted because they did not mention it.
	 */
	prune?: boolean;
}

export function planFleet(
	desired: readonly InventoryRecord[],
	actual: readonly InventoryRecord[],
	options: PlanOptions = {}
): FleetPlan {
	const byName = new Map(actual.map((r) => [r.worker, r]));
	const actions: PlannedAction[] = [];

	for (const want of desired) {
		const have = byName.get(want.worker);
		if (have === undefined) {
			actions.push({
				kind: 'create',
				worker: want.worker,
				changes: ['does not exist'],
				desired: want
			});
			continue;
		}
		byName.delete(want.worker);
		const changes = differences(want, have);
		actions.push({
			kind: changes.length === 0 ? 'unchanged' : 'update',
			worker: want.worker,
			changes,
			desired: want,
			actual: have
		});
	}

	if (options.prune === true) {
		for (const leftover of byName.values()) {
			actions.push({
				kind: 'delete',
				worker: leftover.worker,
				changes: ['not in the desired set'],
				actual: leftover
			});
		}
	}

	const of = (kind: ActionKind): PlannedAction[] => actions.filter((a) => a.kind === kind);
	const create = of('create');
	const update = of('update');
	const remove = of('delete');
	const unchanged = of('unchanged');

	return {
		actions,
		create,
		update,
		remove,
		unchanged,
		get empty() {
			return create.length + update.length + remove.length === 0;
		}
	};
}
