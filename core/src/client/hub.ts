/**
 * Several planes, and the budgets they share.
 *
 * A control plane holds more than one credential: its own account, a dispatch namespace, and one per
 * customer who brought their own account.
 *
 * **Budgets are keyed by credential, not by plane and not by account.** Cloudflare's limit counts the
 * USER, across the dashboard and every token together, so a governor per account would be three
 * governors each believing it owned the whole allowance while the account locked out and all three
 * read healthy. Two accounts reached with one token therefore share one budget. Two tokens cannot be
 * shown to belong to one user from outside, so the default is one budget per token, which is right
 * whenever a user holds one; a caller who knows better passes `budgetKey`.
 */

import type { Plane } from '../plane/plane.js';
import { Budget, BudgetRegistry, type BudgetOptions } from './budget.js';
import { UsageError } from './errors.js';

export interface HubOptions {
	budget?: BudgetOptions;
}

export interface HubEntry {
	name: string;
	plane: Plane;
}

export class Hub {
	private readonly planes = new Map<string, Plane>();
	private readonly budgets: BudgetRegistry;

	constructor(options: HubOptions = {}) {
		this.budgets = new BudgetRegistry(options.budget);
	}

	/** the governor this credential spends against, shared with every plane using the same one */
	budgetFor(credentialKey: string): Budget {
		return this.budgets.for(credentialKey);
	}

	add(name: string, plane: Plane): this {
		if (this.planes.has(name)) {
			throw new UsageError(`the hub already holds a plane named ${name}`);
		}
		this.planes.set(name, plane);
		return this;
	}

	get(name: string): Plane {
		const plane = this.planes.get(name);
		if (plane === undefined) {
			const known = [...this.planes.keys()].join(', ');
			throw new UsageError(
				`no plane named ${name} in this hub${known === '' ? '' : `; it holds ${known}`}`
			);
		}
		return plane;
	}

	has(name: string): boolean {
		return this.planes.has(name);
	}

	list(): HubEntry[] {
		return [...this.planes.entries()].map(([name, plane]) => ({ name, plane }));
	}

	/** planes grouped by the credential they spend, which is what a budget actually covers */
	byCredential(): Map<string, HubEntry[]> {
		const out = new Map<string, HubEntry[]>();
		for (const entry of this.list()) {
			const existing = out.get(entry.plane.credentialKey) ?? [];
			existing.push(entry);
			out.set(entry.plane.credentialKey, existing);
		}
		return out;
	}
}

export function hub(options: HubOptions = {}): Hub {
	return new Hub(options);
}
