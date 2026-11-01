/**
 * A fleet change as an operation: a plan bound by digest, one state per action, and a fencing epoch
 * that refuses a writer holding an older view.
 *
 * An operation is complete when every action has been observed in a terminal state on its target,
 * not when the caller says it finished, so a retry and an interrupted run read the same way.
 */

import { UsageError } from '../client/errors.js';

export type ActionKind = 'create' | 'update' | 'delete';

export type ActionState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

const TERMINAL: readonly ActionState[] = ['succeeded', 'failed', 'skipped'];

export interface PlannedOperationAction {
	id: string;
	worker: string;
	/** the plane and account the action lands on */
	target: string;
	kind: ActionKind;
}

export interface OperationAction extends PlannedOperationAction {
	state: ActionState;
}

export interface FleetOperation {
	planDigest: string;
	epoch: number;
	actions: OperationAction[];
}

export async function planDigest(plan: readonly PlannedOperationAction[]): Promise<string> {
	const text = JSON.stringify(plan.map((a) => [a.id, a.worker, a.target, a.kind]));
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createOperation(
	plan: readonly PlannedOperationAction[],
	epoch: number
): Promise<FleetOperation> {
	const ids = new Set<string>();
	for (const action of plan) {
		if (ids.has(action.id)) throw new UsageError(`action ${action.id} is planned twice`);
		ids.add(action.id);
	}
	return {
		planDigest: await planDigest(plan),
		epoch,
		actions: plan.map((action) => ({ ...action, state: 'pending' }))
	};
}

/** a write under any epoch other than the operation's is refused, so a stale writer cannot land */
export function recordAction(
	op: FleetOperation,
	id: string,
	state: ActionState,
	epoch: number
): FleetOperation {
	if (epoch !== op.epoch) {
		throw new UsageError(`epoch ${epoch} is not the operation's epoch ${op.epoch}`);
	}
	if (!op.actions.some((action) => action.id === id)) {
		throw new UsageError(`no action ${id} in this operation`);
	}
	return {
		...op,
		actions: op.actions.map((action) => (action.id === id ? { ...action, state } : action))
	};
}

export function isComplete(op: FleetOperation): boolean {
	return op.actions.every((action) => TERMINAL.includes(action.state));
}

export async function assertPlan(
	op: FleetOperation,
	plan: readonly PlannedOperationAction[]
): Promise<void> {
	if ((await planDigest(plan)) !== op.planDigest) {
		throw new UsageError('the plan changed after this operation was created');
	}
}

export function serializeOperation(op: FleetOperation): string {
	return JSON.stringify(op);
}

export function parseOperation(text: string): FleetOperation {
	const v = JSON.parse(text) as Partial<FleetOperation>;
	if (
		typeof v.planDigest !== 'string' ||
		!Number.isInteger(v.epoch) ||
		!Array.isArray(v.actions)
	) {
		throw new UsageError('not a fleet operation');
	}
	return v as FleetOperation;
}
