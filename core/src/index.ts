/**
 * workforce: management and fleet operations for Cloudflare Workers.
 *
 * ```ts
 * import { cloudflare, fromFiles, workforce } from '@drupflare/workforce';
 *
 * const cf = workforce({ plane: cloudflare({ accountId, token }) });
 * await cf.worker('my-api').upload({ source: fromFiles({ 'index.js': code }) });
 * ```
 */

import type { Plane } from './plane/plane.js';
import { WorkerHandle } from './worker/script.js';

export * from './access.js';
export * from './assets.js';
export * from './client/budget.js';
export * from './client/errors.js';
export * from './client/fetch.js';
export * from './client/hub.js';
export * from './client/paginate.js';
export * from './environments.js';
export * from './events.js';
export * from './fleet/apply.js';
export * from './fleet/inventory.js';
export * from './fleet/map.js';
export * from './fleet/plan.js';
export * from './health.js';
export * from './observability.js';
export * from './plane/cloudflare.js';
export * from './plane/dispatch.js';
export * from './plane/plane.js';
export * from './resources.js';
export * from './revisions/codec.js';
export * from './revisions/compact.js';
export * from './revisions/diff.js';
export * from './revisions/frame.js';
export * from './revisions/revert.js';
export * from './revisions/store.js';
export * from './revisions/verify.js';
export * from './source.js';
export * from './versions.js';
export * from './worker/bindings.js';
export * from './worker/routing.js';
export * from './worker/script.js';
export * from './worker/upload.js';

export interface WorkforceOptions {
	plane: Plane;
}

/** The client: a plane, plus the operations built on top of it. */
export class Workforce {
	readonly plane: Plane;

	constructor(options: WorkforceOptions) {
		this.plane = options.plane;
	}

	/** what this plane can and cannot do, with a reason attached to each refusal */
	get capabilities(): Plane['capabilities'] {
		return this.plane.capabilities;
	}

	/** a handle to one Worker; free to make, and it touches nothing until asked */
	worker(name: string): WorkerHandle {
		return new WorkerHandle(this.plane, name);
	}

	async list(options: { limit?: number } = {}): Promise<WorkerHandle[]> {
		const summaries = await this.plane.list(options);
		return summaries.map((summary) => new WorkerHandle(this.plane, summary.name));
	}

	/** the escape hatch: any path on this plane, with the envelope read and the budget respected */
	get raw(): Plane['http'] {
		return this.plane.http;
	}
}

export function workforce(options: WorkforceOptions): Workforce {
	return new Workforce(options);
}
