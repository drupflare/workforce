/**
 * Creating the things a Worker binds to.
 *
 * A fleet manager that can create a Worker but not the D1 it binds to is half a tool, so provisioning
 * a Worker can provision what its bindings point at.
 *
 * The cap that bites is D1's ten databases per account on the free plan. A caller making one database
 * per tenant meets it almost immediately, so `createD1` counts first and refuses by name rather than
 * relaying a quota failure from four calls later.
 */

import { UsageError } from './client/errors.js';
import type { HttpClient } from './client/fetch.js';
import { collect } from './client/paginate.js';

/**
 * Published D1 limits.
 *
 * @see https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_LIMITS = {
	databasesFree: 10,
	databasesPaid: 50_000,
	/** bytes; not increasable on either plan */
	databaseBytesFree: 500_000_000,
	databaseBytesPaid: 10_000_000_000,
	accountBytesFree: 5_000_000_000,
	accountBytesPaid: 1_000_000_000_000,
	queriesPerInvocationFree: 50,
	queriesPerInvocationPaid: 1000,
	maxStatementBytes: 100_000,
	maxRowBytes: 2_000_000
} as const;

export interface D1Database {
	uuid: string;
	name: string;
	createdAt: string | null;
}

export interface KVNamespace {
	id: string;
	title: string;
}

export interface R2Bucket {
	name: string;
	createdAt: string | null;
}

export interface ResourceOptions {
	/** which cap to check against; `free` is assumed because it is the one that bites */
	plan?: 'free' | 'paid';
}

/** The resource surface for one account. */
export class Resources {
	constructor(
		private readonly http: HttpClient,
		private readonly accountId: string,
		private readonly options: ResourceOptions = {}
	) {}

	private get databaseCap(): number {
		return this.options.plan === 'paid' ? D1_LIMITS.databasesPaid : D1_LIMITS.databasesFree;
	}

	async listD1(): Promise<D1Database[]> {
		const rows = await collect<{ uuid?: string; name?: string; created_at?: string }>(
			this.http,
			`/accounts/${this.accountId}/d1/database`
		);
		return rows.map((row) => ({
			uuid: String(row.uuid ?? ''),
			name: String(row.name ?? ''),
			createdAt: row.created_at ?? null
		}));
	}

	/**
	 * Creates a D1 database, after checking there is room for it.
	 *
	 * The count costs one request and buys a refusal that names the cap, which is worth more than the
	 * request when the alternative is a quota error whose number nobody remembers.
	 */
	async createD1(name: string, options: { location?: string } = {}): Promise<D1Database> {
		const existing = await this.listD1();
		if (existing.length >= this.databaseCap) {
			throw new UsageError(
				`this account already holds ${existing.length} D1 databases and the ${this.options.plan ?? 'free'} plan allows ${this.databaseCap}; delete one or move to a paid plan rather than retrying`
			);
		}
		if (existing.some((db) => db.name === name)) {
			throw new UsageError(`a D1 database named ${name} already exists on this account`);
		}
		const created = await this.http.request<{
			uuid?: string;
			name?: string;
			created_at?: string;
		}>(`/accounts/${this.accountId}/d1/database`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name,
				...(options.location === undefined
					? {}
					: { primary_location_hint: options.location })
			})
		});
		return {
			uuid: String(created.uuid ?? ''),
			name: String(created.name ?? name),
			createdAt: created.created_at ?? null
		};
	}

	async deleteD1(uuid: string): Promise<void> {
		await this.http.send(`/accounts/${this.accountId}/d1/database/${uuid}`, {
			method: 'DELETE'
		});
	}

	async listKv(): Promise<KVNamespace[]> {
		const rows = await collect<{ id?: string; title?: string }>(
			this.http,
			`/accounts/${this.accountId}/storage/kv/namespaces`
		);
		return rows.map((row) => ({ id: String(row.id ?? ''), title: String(row.title ?? '') }));
	}

	async createKv(title: string): Promise<KVNamespace> {
		const created = await this.http.request<{ id?: string; title?: string }>(
			`/accounts/${this.accountId}/storage/kv/namespaces`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title })
			}
		);
		return { id: String(created.id ?? ''), title: String(created.title ?? title) };
	}

	async deleteKv(id: string): Promise<void> {
		await this.http.send(`/accounts/${this.accountId}/storage/kv/namespaces/${id}`, {
			method: 'DELETE'
		});
	}

	async listR2(): Promise<R2Bucket[]> {
		const result = await this.http.request<{
			buckets?: { name?: string; creation_date?: string }[];
		}>(`/accounts/${this.accountId}/r2/buckets`);
		return (result.buckets ?? []).map((row) => ({
			name: String(row.name ?? ''),
			createdAt: row.creation_date ?? null
		}));
	}

	async createR2(name: string, options: { location?: string } = {}): Promise<R2Bucket> {
		const created = await this.http.request<{ name?: string; creation_date?: string }>(
			`/accounts/${this.accountId}/r2/buckets`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name,
					...(options.location === undefined ? {} : { locationHint: options.location })
				})
			}
		);
		return { name: String(created.name ?? name), createdAt: created.creation_date ?? null };
	}

	async deleteR2(name: string): Promise<void> {
		await this.http.send(`/accounts/${this.accountId}/r2/buckets/${name}`, {
			method: 'DELETE'
		});
	}
}
