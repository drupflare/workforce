/**
 * Cloudflare Access over a Worker.
 *
 * Added 2026-08-14 and it is the piece that makes a managed preview gateable: a policy attached to the
 * WORKER covers every domain it is reached by, including its `workers.dev` hostname, rather than one
 * hostname at a time. It needs no zone, which is what makes it usable for a preview that has no
 * custom domain.
 */

import type { HttpClient } from './client/fetch.js';
import { collect } from './client/paginate.js';

export type AccessDestinationType = 'worker' | 'preview_worker';

export interface AccessApp {
	id: string;
	name: string;
	/** the worker ids this policy covers */
	workerIds: string[];
	type: string;
}

export interface CreateAccessApp {
	name: string;
	/** Cloudflare's own id for the script, not its name */
	workerId: string;
	/** `preview_worker` covers only preview deployments; `worker` covers production too */
	destination?: AccessDestinationType;
	sessionDuration?: string;
	/** policy ids to attach, when the caller already has them */
	policies?: string[];
}

interface AppRow {
	id?: string;
	name?: string;
	type?: string;
	destinations?: { type?: string; worker_id?: string }[];
}

function appOf(row: AppRow): AccessApp {
	return {
		id: String(row.id ?? ''),
		name: String(row.name ?? ''),
		type: String(row.type ?? ''),
		workerIds: (row.destinations ?? [])
			.map((d) => String(d.worker_id ?? ''))
			.filter((id) => id !== '')
	};
}

export class Access {
	constructor(
		private readonly http: HttpClient,
		private readonly accountId: string
	) {}

	private get base(): string {
		return `/accounts/${this.accountId}/access/apps`;
	}

	async list(): Promise<AccessApp[]> {
		return (await collect<AppRow>(this.http, this.base)).map(appOf);
	}

	/** the app covering this worker, so a second run does not create a duplicate */
	async forWorker(workerId: string): Promise<AccessApp | null> {
		return (await this.list()).find((app) => app.workerIds.includes(workerId)) ?? null;
	}

	async create(input: CreateAccessApp): Promise<AccessApp> {
		const row = await this.http.request<AppRow>(this.base, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: input.name,
				type: 'self_hosted',
				session_duration: input.sessionDuration ?? '24h',
				destinations: [{ type: input.destination ?? 'worker', worker_id: input.workerId }],
				...(input.policies === undefined ? {} : { policies: input.policies })
			})
		});
		return appOf(row);
	}

	async delete(id: string): Promise<void> {
		await this.http.send(`${this.base}/${id}`, { method: 'DELETE' });
	}

	/** create, or return the one already covering this worker */
	async ensure(input: CreateAccessApp): Promise<AccessApp> {
		return (await this.forWorker(input.workerId)) ?? (await this.create(input));
	}
}
