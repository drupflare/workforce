/**
 * Desired against actual, as a plan a caller can read before anything happens.
 *
 * A fleet change that only reports what it did is one you have to run to understand. A plan is the
 * same computation with the acting half removed, which is what makes a dry run meaningful rather than
 * decorative.
 */

import { UsageError } from '../client/errors.js';
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

/** a worker is its plane, its account and its name; the same name elsewhere is another worker */
function identityOf(record: InventoryRecord): string {
	return JSON.stringify([record.plane, record.scope ?? null, record.worker]);
}

function indexed(records: readonly InventoryRecord[], side: string): Map<string, InventoryRecord> {
	const index = new Map<string, InventoryRecord>();
	for (const record of records) {
		const key = identityOf(record);
		if (index.has(key)) {
			const where =
				record.scope === undefined ? record.plane : `${record.plane} ${record.scope}`;
			throw new UsageError(`${side} lists ${record.worker} on ${where} twice`);
		}
		index.set(key, record);
	}
	return index;
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
	const wanted = indexed(desired, 'desired');
	const present = indexed(actual, 'actual');
	const actions: PlannedAction[] = [];

	for (const [key, want] of wanted) {
		const have = present.get(key);
		if (have === undefined) {
			actions.push({
				kind: 'create',
				worker: want.worker,
				changes: ['does not exist'],
				desired: want
			});
			continue;
		}
		present.delete(key);
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
		for (const leftover of present.values()) {
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
