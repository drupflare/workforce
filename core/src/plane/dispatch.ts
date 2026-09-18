/**
 * Workers for Platforms, through a dispatch namespace.
 *
 * The same job as the account-scoped plane with a narrower surface, and the gaps are structural rather
 * than missing features. Confirmed by their absence from Cloudflare's own endpoint listing: a
 * namespaced script has no `/versions`, no `/deployments`, no `/subdomain`, no `/schedules` and no
 * `/tails`. So release identity has to be application-level here, which is what the revision store is.
 *
 * What it does have that plain scripts do not is `/tags` as a subresource, capped at eight per script.
 */

import { Budget } from '../client/budget.js';
import { UsageError } from '../client/errors.js';
import { HttpClient, type ClientOptions } from '../client/fetch.js';
import { collect } from '../client/paginate.js';
import type { Binding } from '../worker/bindings.js';
import type { BuiltUpload } from '../worker/upload.js';
import { assertWorkerName } from './cloudflare.js';
import {
	CAN,
	cannot,
	type Plane,
	type PlaneCapabilities,
	type SecretSummary,
	type UploadResult,
	type WorkerSettings,
	type WorkerSummary
} from './plane.js';

/** Workers for Platforms allows eight tags per script */
export const MAX_DISPATCH_TAGS = 8;

export interface DispatchOptions extends ClientOptions {
	accountId: string;
	token: string;
	namespace: string;
	budgetKey?: string;
}

const NO_VERSIONS =
	'a dispatch namespace script has no /versions endpoint, so release identity has to be application-level; use a RevisionStore';

export const DISPATCH_CAPABILITIES: PlaneCapabilities = {
	versions: cannot(NO_VERSIONS),
	deployments: cannot(
		'a dispatch namespace script has no /deployments endpoint, so there is nothing to split traffic across'
	),
	subdomain: cannot(
		'a dispatch namespace script has no workers.dev subdomain; it is reached through the dispatch Worker'
	),
	schedules: cannot('a dispatch namespace script has no /schedules endpoint'),
	tails: cannot('a dispatch namespace script has no /tails endpoint'),
	analytics: CAN,
	assets: CAN,
	access: CAN,
	routes: cannot(
		'a dispatch namespace script is not routed directly; the dispatch Worker decides what reaches it'
	),
	tags: CAN,
	maxTags: MAX_DISPATCH_TAGS
};

interface ScriptRow {
	id?: string;
	created_on?: string;
	modified_on?: string;
}

export class DispatchPlane implements Plane {
	readonly kind = 'dispatch' as const;
	readonly capabilities = DISPATCH_CAPABILITIES;
	readonly http: HttpClient;
	readonly accountId: string;
	readonly namespace: string;
	readonly credentialKey: string;

	constructor(options: DispatchOptions) {
		if (options.accountId === '') throw new UsageError('no account id');
		if (options.token === '') throw new UsageError('no API token');
		if (options.namespace === '') throw new UsageError('no dispatch namespace');
		this.accountId = options.accountId;
		this.namespace = options.namespace;
		this.credentialKey = options.budgetKey ?? options.token;
		this.http = new HttpClient(() => ({ authorization: `Bearer ${options.token}` }), {
			...options,
			budget: options.budget ?? new Budget()
		});
	}

	get target(): string {
		return `namespace ${this.namespace} on account ${this.accountId}`;
	}

	get base(): string {
		return `/accounts/${this.accountId}/workers/dispatch/namespaces/${this.namespace}`;
	}

	async list(options: { limit?: number } = {}): Promise<WorkerSummary[]> {
		const rows = await collect<ScriptRow>(this.http, `${this.base}/scripts`, {
			limit: options.limit
		});
		const out: WorkerSummary[] = [];
		for (const row of rows) {
			const name = String(row.id ?? '');
			if (name === '') continue;
			out.push({
				name,
				id: name,
				createdOn: row.created_on ?? null,
				modifiedOn: row.modified_on ?? null,
				tags: []
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	async get(name: string): Promise<WorkerSummary | null> {
		assertWorkerName(name);
		try {
			const row = await this.http.request<ScriptRow>(`${this.base}/scripts/${name}`);
			return {
				name,
				id: name,
				createdOn: row.created_on ?? null,
				modifiedOn: row.modified_on ?? null,
				tags: await this.tags(name)
			};
		} catch (error) {
			if (error instanceof Error && error.name === 'NotFoundError') return null;
			throw error;
		}
	}

	async exists(name: string): Promise<boolean> {
		return (await this.get(name)) !== null;
	}

	async upload(name: string, upload: BuiltUpload): Promise<UploadResult> {
		assertWorkerName(name);
		const response = await this.http.send(`${this.base}/scripts/${name}`, {
			method: 'PUT',
			body: upload.body
		});
		const body = (await response.json()) as {
			success?: boolean;
			errors?: { code?: number; message?: string }[];
			result?: { id?: string; etag?: string };
		};
		if (body.success === false || body.result === undefined) {
			const detail = (body.errors ?? []).map((e) => e.message ?? String(e.code)).join('; ');
			throw new UsageError(
				`uploading ${name} to ${this.namespace} was refused: ${detail === '' ? `HTTP ${response.status}` : detail}`
			);
		}
		// no version id here by construction: this plane has no versions
		return { name, versionId: null, etag: body.result.etag ?? null, metadata: upload.metadata };
	}

	async delete(name: string): Promise<void> {
		assertWorkerName(name);
		await this.http.send(`${this.base}/scripts/${name}`, {
			method: 'DELETE',
			query: { force: true }
		});
	}

	async settings(name: string): Promise<WorkerSettings> {
		assertWorkerName(name);
		const row = await this.http.request<Record<string, unknown>>(
			`${this.base}/scripts/${name}/settings`
		);
		return {
			bindings: (row.bindings as Binding[]) ?? [],
			compatibilityDate: (row.compatibility_date as string) ?? null,
			compatibilityFlags: (row.compatibility_flags as string[]) ?? [],
			tags: await this.tags(name),
			logpush: (row.logpush as boolean) ?? null,
			observability:
				(row.observability as { enabled: boolean; head_sampling_rate?: number }) ?? null,
			raw: row
		};
	}

	async patchSettings(name: string, settings: Partial<WorkerSettings>): Promise<WorkerSettings> {
		assertWorkerName(name);
		const payload: Record<string, unknown> = {};
		if (settings.bindings !== undefined) payload.bindings = settings.bindings;
		if (settings.compatibilityDate !== undefined) {
			payload.compatibility_date = settings.compatibilityDate;
		}
		if (settings.compatibilityFlags !== undefined) {
			payload.compatibility_flags = settings.compatibilityFlags;
		}
		if (settings.logpush !== undefined) payload.logpush = settings.logpush;
		if (settings.observability !== undefined) payload.observability = settings.observability;

		await this.http.request(`${this.base}/scripts/${name}/settings`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ settings: payload })
		});
		// tags live in their own subresource here, so a settings patch never carries them
		if (settings.tags !== undefined) await this.setTags(name, settings.tags);
		return this.settings(name);
	}

	async content(name: string): Promise<Response> {
		assertWorkerName(name);
		return this.http.send(`${this.base}/scripts/${name}/content`);
	}

	async listSecrets(name: string): Promise<SecretSummary[]> {
		assertWorkerName(name);
		const rows = await collect<{ name?: string; type?: string }>(
			this.http,
			`${this.base}/scripts/${name}/secrets`
		);
		return rows.map((row) => ({ name: String(row.name ?? ''), type: String(row.type ?? '') }));
	}

	async putSecret(name: string, secret: { name: string; text: string }): Promise<void> {
		assertWorkerName(name);
		await this.http.request(`${this.base}/scripts/${name}/secrets`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: secret.name, text: secret.text, type: 'secret_text' })
		});
	}

	async deleteSecret(name: string, secretName: string): Promise<void> {
		assertWorkerName(name);
		await this.http.send(
			`${this.base}/scripts/${name}/secrets/${encodeURIComponent(secretName)}`,
			{ method: 'DELETE' }
		);
	}

	async tags(name: string): Promise<string[]> {
		const rows = await collect<string>(this.http, `${this.base}/scripts/${name}/tags`);
		return rows.map((row) => String(row));
	}

	/** Refuses past the cap rather than letting the API drop the overflow quietly. */
	async setTags(name: string, tags: string[]): Promise<string[]> {
		assertWorkerName(name);
		if (tags.length > MAX_DISPATCH_TAGS) {
			throw new UsageError(
				`Workers for Platforms allows ${MAX_DISPATCH_TAGS} tags per script and this is ${tags.length}; put the rest in the inventory store`
			);
		}
		await this.http.request(`${this.base}/scripts/${name}/tags`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(tags)
		});
		return tags;
	}
}

export function dispatch(options: DispatchOptions): DispatchPlane {
	return new DispatchPlane(options);
}

export interface DispatchNamespace {
	name: string;
	createdOn: string | null;
	scriptCount: number | null;
}

/** namespace management, which is an account-level concern rather than a per-script one */
export class DispatchNamespaces {
	constructor(
		private readonly http: HttpClient,
		private readonly accountId: string
	) {}

	private get base(): string {
		return `/accounts/${this.accountId}/workers/dispatch/namespaces`;
	}

	async list(): Promise<DispatchNamespace[]> {
		const rows = await collect<{
			namespace_name?: string;
			created_on?: string;
			script_count?: number;
		}>(this.http, this.base);
		return rows.map((row) => ({
			name: String(row.namespace_name ?? ''),
			createdOn: row.created_on ?? null,
			scriptCount: row.script_count ?? null
		}));
	}

	async create(name: string): Promise<DispatchNamespace> {
		const row = await this.http.request<{ namespace_name?: string; created_on?: string }>(
			this.base,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			}
		);
		return {
			name: String(row.namespace_name ?? name),
			createdOn: row.created_on ?? null,
			scriptCount: 0
		};
	}

	async delete(name: string): Promise<void> {
		await this.http.send(`${this.base}/${name}`, { method: 'DELETE' });
	}
}
