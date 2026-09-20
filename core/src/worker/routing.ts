/**
 * Where a Worker is reachable: its `workers.dev` subdomain, its cron triggers, its zone routes and
 * its custom domains.
 */

import type { HttpClient } from '../client/fetch.js';
import { collect } from '../client/paginate.js';

export interface SubdomainState {
	enabled: boolean;
	/** whether per-version preview URLs are on; a managed preview turns these off */
	previewsEnabled: boolean | null;
}

export interface Schedule {
	cron: string;
	createdOn?: string | null;
	modifiedOn?: string | null;
}

export interface Route {
	id: string;
	pattern: string;
	script: string | null;
}

export interface WorkerDomain {
	id: string;
	hostname: string;
	zoneId: string;
	service: string;
	environment: string;
}

export class Routing {
	constructor(
		private readonly http: HttpClient,
		private readonly accountId: string
	) {}

	private scriptBase(name: string): string {
		return `/accounts/${this.accountId}/workers/scripts/${name}`;
	}

	async subdomain(name: string): Promise<SubdomainState> {
		const result = await this.http.request<{ enabled?: boolean; previews_enabled?: boolean }>(
			`${this.scriptBase(name)}/subdomain`
		);
		return {
			enabled: result.enabled === true,
			previewsEnabled: result.previews_enabled ?? null
		};
	}

	/**
	 * Turns the `workers.dev` hostname on or off.
	 *
	 * `previews` is separate and worth setting deliberately: a managed preview wants exactly one URL,
	 * so it enables the subdomain and turns per-version preview URLs off. Preview URLs also carry no
	 * logs at all, which is the other reason not to rely on them.
	 */
	async setSubdomain(
		name: string,
		options: { enabled: boolean; previews?: boolean }
	): Promise<SubdomainState> {
		const result = await this.http.request<{ enabled?: boolean; previews_enabled?: boolean }>(
			`${this.scriptBase(name)}/subdomain`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enabled: options.enabled,
					...(options.previews === undefined
						? {}
						: { previews_enabled: options.previews })
				})
			}
		);
		return {
			enabled: result.enabled === true,
			previewsEnabled: result.previews_enabled ?? null
		};
	}

	/** the account's `workers.dev` name, which every subdomain-enabled Worker sits under */
	async accountSubdomain(): Promise<string | null> {
		const result = await this.http.request<{ subdomain?: string }>(
			`/accounts/${this.accountId}/workers/subdomain`
		);
		return result.subdomain ?? null;
	}

	/** where a subdomain-enabled Worker answers, or null when the account has no subdomain yet */
	async hostname(name: string): Promise<string | null> {
		const account = await this.accountSubdomain();
		return account === null ? null : `${name}.${account}.workers.dev`;
	}

	async schedules(name: string): Promise<Schedule[]> {
		const result = await this.http.request<{ schedules?: Schedule[] }>(
			`${this.scriptBase(name)}/schedules`
		);
		return result.schedules ?? [];
	}

	async setSchedules(name: string, crons: string[]): Promise<Schedule[]> {
		const result = await this.http.request<{ schedules?: Schedule[] }>(
			`${this.scriptBase(name)}/schedules`,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(crons.map((cron) => ({ cron })))
			}
		);
		return result.schedules ?? crons.map((cron) => ({ cron }));
	}

	async routes(zoneId: string): Promise<Route[]> {
		const rows = await collect<{ id?: string; pattern?: string; script?: string }>(
			this.http,
			`/zones/${zoneId}/workers/routes`
		);
		return rows.map((row) => ({
			id: String(row.id ?? ''),
			pattern: String(row.pattern ?? ''),
			script: row.script ?? null
		}));
	}

	async addRoute(zoneId: string, pattern: string, script: string): Promise<Route> {
		const row = await this.http.request<{ id?: string }>(`/zones/${zoneId}/workers/routes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pattern, script })
		});
		return { id: String(row.id ?? ''), pattern, script };
	}

	async deleteRoute(zoneId: string, routeId: string): Promise<void> {
		await this.http.send(`/zones/${zoneId}/workers/routes/${routeId}`, { method: 'DELETE' });
	}

	async domains(): Promise<WorkerDomain[]> {
		const rows = await collect<{
			id?: string;
			hostname?: string;
			zone_id?: string;
			service?: string;
			environment?: string;
		}>(this.http, `/accounts/${this.accountId}/workers/domains`);
		return rows.map((row) => ({
			id: String(row.id ?? ''),
			hostname: String(row.hostname ?? ''),
			zoneId: String(row.zone_id ?? ''),
			service: String(row.service ?? ''),
			environment: String(row.environment ?? 'production')
		}));
	}

	async attachDomain(input: {
		hostname: string;
		zoneId: string;
		service: string;
		environment?: string;
	}): Promise<WorkerDomain> {
		const row = await this.http.request<{ id?: string }>(
			`/accounts/${this.accountId}/workers/domains`,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					hostname: input.hostname,
					zone_id: input.zoneId,
					service: input.service,
					environment: input.environment ?? 'production'
				})
			}
		);
		return {
			id: String(row.id ?? ''),
			hostname: input.hostname,
			zoneId: input.zoneId,
			service: input.service,
			environment: input.environment ?? 'production'
		};
	}

	async detachDomain(id: string): Promise<void> {
		await this.http.send(`/accounts/${this.accountId}/workers/domains/${id}`, {
			method: 'DELETE'
		});
	}
}
