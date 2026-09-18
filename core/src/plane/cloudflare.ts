/**
 * Account-scoped Workers on `api.cloudflare.com`.
 *
 * The reference plane, and the only one with the full surface: versions, deployments, subdomains,
 * cron triggers, tails and analytics all exist here and are absent or different elsewhere.
 */

import { Budget } from '../client/budget.js';
import { UsageError } from '../client/errors.js';
import { HttpClient, type ClientOptions } from '../client/fetch.js';
import { collect } from '../client/paginate.js';
import type { Binding } from '../worker/bindings.js';
import type { BuiltUpload } from '../worker/upload.js';
import {
	CAN,
	type Plane,
	type PlaneCapabilities,
	type SecretSummary,
	type UploadResult,
	type WorkerSettings,
	type WorkerSummary
} from './plane.js';

export interface CloudflareOptions extends ClientOptions {
	accountId: string;
	token: string;
	/**
	 * Groups this plane's spending with others under one governor.
	 *
	 * Defaults to the token, which is right whenever a user holds one. Two tokens belonging to one
	 * user cannot be told apart from outside, so a caller who knows they do says so here.
	 */
	budgetKey?: string;
}

/** everything works here; this is the plane the others are described against */
export const CLOUDFLARE_CAPABILITIES: PlaneCapabilities = {
	versions: CAN,
	deployments: CAN,
	subdomain: CAN,
	schedules: CAN,
	tails: CAN,
	analytics: CAN,
	assets: CAN,
	access: CAN,
	routes: CAN,
	tags: CAN,
	maxTags: null
};

interface ScriptRow {
	/**
	 * On `GET /scripts` this IS the worker name; on `GET /scripts-search` it is Cloudflare's own hex
	 * id and the name arrives as `script_name`. Measured against the real API, and the difference is
	 * what made `exists()` answer false for a worker that had just uploaded.
	 */
	id?: string;
	script_name?: string;
	created_on?: string;
	modified_on?: string;
	tags?: string[];
}

interface SettingsRow {
	bindings?: Binding[];
	compatibility_date?: string;
	compatibility_flags?: string[];
	tags?: string[];
	logpush?: boolean;
	observability?: { enabled: boolean; head_sampling_rate?: number };
	[key: string]: unknown;
}

function summaryOf(row: ScriptRow): WorkerSummary {
	// script_name wins when present, because only the search endpoint sends it and only there is
	// `id` something other than the name
	const name = String(row.script_name ?? row.id ?? '');
	return {
		name,
		id: row.id ?? null,
		createdOn: row.created_on ?? null,
		modifiedOn: row.modified_on ?? null,
		tags: row.tags ?? []
	};
}

function settingsOf(row: SettingsRow): WorkerSettings {
	return {
		bindings: row.bindings ?? [],
		compatibilityDate: row.compatibility_date ?? null,
		compatibilityFlags: row.compatibility_flags ?? [],
		tags: row.tags ?? [],
		logpush: row.logpush ?? null,
		observability: row.observability ?? null,
		raw: row
	};
}

/** Refuses a name the API would mangle rather than reject, which is harder to notice. */
export function assertWorkerName(name: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
		throw new UsageError(
			`${name} is not a usable Worker name: lower case, digits and hyphens, starting with a letter or digit, up to 63 characters`
		);
	}
}

export class CloudflarePlane implements Plane {
	readonly kind = 'cloudflare' as const;
	readonly capabilities = CLOUDFLARE_CAPABILITIES;
	readonly http: HttpClient;
	readonly accountId: string;
	readonly credentialKey: string;

	constructor(options: CloudflareOptions) {
		if (options.accountId === '') throw new UsageError('no account id');
		if (options.token === '') throw new UsageError('no API token');
		this.accountId = options.accountId;
		this.credentialKey = options.budgetKey ?? options.token;
		this.http = new HttpClient(() => ({ authorization: `Bearer ${options.token}` }), {
			...options,
			budget: options.budget ?? new Budget()
		});
	}

	get target(): string {
		return `account ${this.accountId}`;
	}

	/** the path prefix every call here shares */
	get base(): string {
		return `/accounts/${this.accountId}/workers`;
	}

	async list(options: { limit?: number } = {}): Promise<WorkerSummary[]> {
		const rows = await collect<ScriptRow>(this.http, `${this.base}/scripts`, {
			limit: options.limit
		});
		return rows
			.map(summaryOf)
			.filter((r) => r.name !== '')
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async get(name: string): Promise<WorkerSummary | null> {
		assertWorkerName(name);
		const rows = await collect<ScriptRow>(this.http, `${this.base}/scripts-search`, {
			query: { name }
		});
		const exact = rows.find((row) => String(row.script_name ?? row.id ?? '') === name);
		return exact === undefined ? null : summaryOf(exact);
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
			result?: { id?: string; etag?: string; startup_time_ms?: number };
		};
		if (body.success === false || body.result === undefined) {
			const detail = (body.errors ?? []).map((e) => e.message ?? String(e.code)).join('; ');
			throw new UsageError(
				`uploading ${name} was refused: ${detail === '' ? `HTTP ${response.status}` : detail}`
			);
		}
		return {
			name,
			versionId: null,
			etag: body.result.etag ?? null,
			metadata: upload.metadata
		};
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
		return settingsOf(
			await this.http.request<SettingsRow>(`${this.base}/scripts/${name}/settings`)
		);
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
		if (settings.tags !== undefined) payload.tags = settings.tags;
		if (settings.logpush !== undefined) payload.logpush = settings.logpush;
		if (settings.observability !== undefined) payload.observability = settings.observability;

		const body = new FormData();
		body.set('settings', JSON.stringify(payload));
		const row = await this.http.request<SettingsRow>(`${this.base}/scripts/${name}/settings`, {
			method: 'PATCH',
			body
		});
		return settingsOf(row);
	}

	async content(name: string): Promise<Response> {
		assertWorkerName(name);
		return this.http.send(`${this.base}/scripts/${name}/content/v2`);
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

	async setTags(name: string, tags: string[]): Promise<string[]> {
		// plain scripts carry tags in settings rather than in a subresource of their own
		const updated = await this.patchSettings(name, { tags });
		return updated.tags;
	}
}

/** the entry a caller uses: `workforce({ plane: cloudflare({ accountId, token }) })` */
export function cloudflare(options: CloudflareOptions): CloudflarePlane {
	return new CloudflarePlane(options);
}
