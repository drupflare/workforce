/**
 * A bastion node, over its management API.
 *
 * The third executor, and the first that is not Cloudflare. bastion runs workerd itself and owns the
 * router, the log and the version store, so versions, deployments, routes, assets and tags are real
 * here rather than emulated on top of a single artifact the way they are in a dispatch namespace.
 * What has no equivalent is the half that belongs to Cloudflare's own network: there is no
 * `workers.dev` on a self-hosted box and no Access in front of it. Cron triggers are absent for a
 * different reason -- workerd itself has none, so no plane over it can schedule anything.
 *
 * The wire shape is bastion's own, `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`,
 * so this plane reads responses itself instead of going through the Cloudflare envelope reader. The
 * tenant a token may reach is carried BY the token, so no call here sends a tenant name.
 *
 * A site is not a script: it is a host, a bundle path and a probe, and it is addressed by the host it
 * serves. The operations that assume Cloudflare's script layout are refused by name rather than
 * pointed at a path this API does not have.
 */

import { Budget } from '../client/budget.js';
import {
	ApiError,
	AuthError,
	NotFoundError,
	TransportError,
	UsageError
} from '../client/errors.js';
import { HttpClient, type ClientOptions, type RequestOptions } from '../client/fetch.js';
import type { BuiltUpload } from '../worker/upload.js';
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

/** every bastion API token starts with this, so a wrong credential is caught before it is spent */
export const BASTION_TOKEN_PREFIX = 'bst_';

export const WORKERD_CAPABILITIES: PlaneCapabilities = {
	// bastion owns its version store, and a version id is the content address of the bundle
	versions: CAN,
	// bastion owns its front door, so a split is a real one rather than a label on one artifact
	deployments: CAN,
	subdomain: cannot(
		'a self-hosted node has no workers.dev; a site is reached at the host it is configured with'
	),
	// workerd has no cron trigger: nothing in `workerd.capnp` configures one, and `server.c++`
	// serves no path that reaches `runScheduled`, which is a C++ interface with no config surface
	// (miniflare injects `/cdn-cgi/handler/scheduled` in a wrapper of its own). So a self-hosted
	// node cannot invoke a Worker's `scheduled()` handler at all, whatever timer sits in front of it
	schedules: cannot(
		'workerd exposes no way to invoke a scheduled() handler; it has no cron trigger in its schema and no http path to runScheduled'
	),
	// the node owns the process, so its log is a read rather than a socket someone else brokers
	tails: CAN,
	// bastion-native: /api/metrics is Prometheus text and /api/logs is the node's own log
	analytics: CAN,
	// the node serves static files itself, out of the bundle it was deployed
	assets: CAN,
	access: cannot(
		'Cloudflare Access is not reachable from a self-hosted node; bastion authorises with its own tokens and sessions'
	),
	// routing is the node's own router, which is why a route here is a site record rather than a rule
	routes: CAN,
	tags: CAN,
	maxTags: null
};

export interface WorkerdOptions extends ClientOptions {
	/** the node's management API, such as `https://node.example.edu` */
	endpoint: string;
	/** a `bst_` token; the tenant it may reach rides on the token and is never a parameter */
	token: string;
	/** groups this node's spending with another plane's, for a caller holding one credential */
	budgetKey?: string;
}

/** one site as bastion stores it */
export interface BastionSite {
	host: string;
	bundle: string;
	probe: string;
	/** bastion binds by name to a target string, which is not the shape a Cloudflare binding has */
	bindings?: Record<string, string>;
	tags?: string[];
}

export interface BastionVersion {
	/** the content address of the bundle; two identical uploads are one version */
	id: string;
	site: string;
	bytes: number;
	uploadedAt: string | null;
	uploadedBy: string | null;
	annotations: Record<string, string>;
}

export interface BastionDeployment {
	site: string;
	current: string;
	/** a canary version and the share of traffic it takes, or null */
	split: { version: string; percent: number } | null;
	at: string | null;
	by: string | null;
}

export interface BastionLogLine {
	at: string | null;
	level: string;
	message: string;
	site: string | null;
	fields: Record<string, unknown>;
}

interface BastionEnvelope {
	ok?: boolean;
	error?: { code?: string; message?: string; retryable?: boolean; next?: string | null };
}

interface SiteRow {
	host?: string;
	name?: string;
	bundle?: string;
	probe?: string;
	bindings?: Record<string, string>;
	tags?: string[];
	createdAt?: number | string;
	updatedAt?: number | string;
	[key: string]: unknown;
}

interface VersionRow {
	id?: string;
	site?: string;
	bytes?: number;
	uploadedAt?: number | string;
	uploadedBy?: string;
	annotations?: Record<string, string>;
}

interface DeploymentRow {
	site?: string;
	current?: string;
	split?: { version?: string; percent?: number } | null;
	at?: number | string;
	by?: string;
}

/** bastion times are epoch milliseconds; everything on the plane interface is an ISO string */
function isoOf(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
	return typeof value === 'string' && value !== '' ? value : null;
}

function nameOf(row: SiteRow): string {
	return String(row.host ?? row.name ?? '');
}

function summaryOf(row: SiteRow): WorkerSummary {
	const name = nameOf(row);
	return {
		name,
		// a site IS its host here; there is no second id the way a Cloudflare script has one
		id: name === '' ? null : name,
		createdOn: isoOf(row.createdAt),
		modifiedOn: isoOf(row.updatedAt),
		tags: row.tags ?? []
	};
}

function settingsOf(row: SiteRow): WorkerSettings {
	return {
		// bastion binds a name to a target string rather than to a typed Cloudflare binding, so the
		// map stays in `raw` instead of being coerced into a shape it does not have
		bindings: [],
		// the bundle carries the runtime date and flags on this plane; the site record does not
		compatibilityDate: null,
		compatibilityFlags: [],
		tags: row.tags ?? [],
		logpush: null,
		observability: null,
		raw: row
	};
}

function versionOf(row: VersionRow): BastionVersion {
	return {
		id: String(row.id ?? ''),
		site: String(row.site ?? ''),
		bytes: row.bytes ?? 0,
		uploadedAt: isoOf(row.uploadedAt),
		uploadedBy: row.uploadedBy ?? null,
		annotations: row.annotations ?? {}
	};
}

function deploymentOf(row: DeploymentRow, site: string): BastionDeployment {
	const split = row.split ?? null;
	return {
		site: String(row.site ?? site),
		current: String(row.current ?? ''),
		split:
			split === null
				? null
				: { version: String(split.version ?? ''), percent: split.percent ?? 0 },
		at: isoOf(row.at),
		by: row.by ?? null
	};
}

function logOf(row: Record<string, unknown>): BastionLogLine {
	const { at, level, message, site, ...fields } = row;
	return {
		at: isoOf(at),
		level: typeof level === 'string' ? level : 'info',
		message: typeof message === 'string' ? message : '',
		site: typeof site === 'string' ? site : null,
		fields
	};
}

/** Refuses a name that is not a host, because a bastion site is addressed by the one it serves. */
export function assertSiteName(name: string): void {
	const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
	if (name.length > 253 || !new RegExp(`^${label}(?:\\.${label})*$`).test(name)) {
		throw new UsageError(
			`${name} is not a usable bastion site: a site is addressed by the host it serves, such as www.example.edu`
		);
	}
}

function noSecrets(name: string): UsageError {
	return new UsageError(
		`bastion secrets are host-level and reachable only from an interactive session, so ${name} has none to read through an API token; set them on the node with \`bastion secrets set\``
	);
}

/**
 * Reads one bastion envelope.
 *
 * `ok` is the check rather than the status, for the same reason the Cloudflare reader does not trust
 * a 200: a refusal that carries a reason is more useful than the number in front of it.
 */
export async function readBastion<T>(response: Response, what: string): Promise<T> {
	let body: T & BastionEnvelope;
	try {
		body = (await response.json()) as T & BastionEnvelope;
	} catch (cause) {
		throw new TransportError(`${what}: HTTP ${response.status} with a non-JSON body`, {
			cause
		});
	}
	const detail = body.error?.message ?? '';
	const suffix = detail === '' ? '' : ` (${detail})`;

	if (response.status === 401 || response.status === 403) {
		throw new AuthError(
			`${what}: HTTP ${response.status}, the node rejected the token${suffix}`
		);
	}
	if (response.status === 404) {
		throw new NotFoundError(`${what}: not found${suffix}`);
	}
	if (body.ok !== true) {
		const code = body.error?.code;
		throw new ApiError(
			`${what}: ${detail === '' ? `HTTP ${response.status}` : detail}`,
			response.status,
			body.error === undefined
				? []
				: [{ code: null, message: code === undefined ? detail : `${code}: ${detail}` }]
		);
	}
	return body;
}

export class WorkerdPlane implements Plane {
	readonly kind = 'workerd' as const;
	readonly capabilities = WORKERD_CAPABILITIES;
	readonly http: HttpClient;
	readonly endpoint: string;
	readonly credentialKey: string;

	constructor(options: WorkerdOptions) {
		if (options.endpoint === '') throw new UsageError('no bastion endpoint');
		if (options.token === '') throw new UsageError('no bastion API token');
		if (!options.token.startsWith(BASTION_TOKEN_PREFIX)) {
			throw new UsageError(
				`a bastion API token starts with ${BASTION_TOKEN_PREFIX} and this one does not; a session cookie is not one`
			);
		}
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.credentialKey = options.budgetKey ?? options.token;
		this.http = new HttpClient(() => ({ authorization: `Bearer ${options.token}` }), {
			...options,
			baseUrl: this.endpoint,
			budget: options.budget ?? new Budget()
		});
	}

	get target(): string {
		return `node ${this.endpoint}`;
	}

	private async call<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.http.send(path, options);
		return readBastion<T>(response, `${options.method ?? 'GET'} ${path}`);
	}

	private json(path: string, method: string, payload: unknown): Promise<unknown> {
		return this.call(path, {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
	}

	/** every site this token may reach; one node answers in one page, so there is nothing to walk */
	async list(options: { limit?: number } = {}): Promise<WorkerSummary[]> {
		const body = await this.call<{ sites?: SiteRow[] }>('/api/sites');
		const rows = (body.sites ?? [])
			.map(summaryOf)
			.filter((row) => row.name !== '')
			.sort((a, b) => a.name.localeCompare(b.name));
		return options.limit === undefined ? rows : rows.slice(0, options.limit);
	}

	async get(name: string): Promise<WorkerSummary | null> {
		assertSiteName(name);
		const rows = await this.list();
		return rows.find((row) => row.name === name) ?? null;
	}

	async exists(name: string): Promise<boolean> {
		return (await this.get(name)) !== null;
	}

	/** the node's own report: what it is running and how it is */
	async status(): Promise<Record<string, unknown>> {
		return this.call<Record<string, unknown>>('/api/status');
	}

	/** Registers a site. A bundle path and a probe have no default, so they are asked for here. */
	async create(site: BastionSite): Promise<WorkerSummary> {
		assertSiteName(site.host);
		const body = (await this.json('/api/sites', 'POST', site)) as { site?: SiteRow };
		return summaryOf(body.site ?? { host: site.host });
	}

	/**
	 * Deploys a bundle to a site that already exists.
	 *
	 * A site is a host, a bundle path and a probe, and an upload carries none of the three, so an
	 * unknown site is a named refusal from the node rather than a site invented from a Worker name.
	 */
	async upload(name: string, upload: BuiltUpload): Promise<UploadResult> {
		assertSiteName(name);
		const body = await this.call<{ version?: VersionRow }>(`/api/sites/${name}/deploy`, {
			method: 'POST',
			body: upload.body
		});
		const id = body.version?.id ?? null;
		// the version id IS the content address of the bundle, so it doubles as the etag
		return { name, versionId: id, etag: id, metadata: upload.metadata };
	}

	/** Removes a site. The route is session-only, so a node may refuse an API token here. */
	async delete(name: string): Promise<void> {
		assertSiteName(name);
		await this.call(`/api/sites/${name}`, { method: 'DELETE' });
	}

	async settings(name: string): Promise<WorkerSettings> {
		return settingsOf(await this.row(name));
	}

	/**
	 * Writes the site record back.
	 *
	 * `POST /api/sites` is the only write on a site record, so it is an upsert rather than a patch
	 * endpoint; the current record is read first and merged, or a partial change would drop the rest.
	 */
	async patchSettings(name: string, settings: Partial<WorkerSettings>): Promise<WorkerSettings> {
		if (settings.bindings !== undefined) {
			throw new UsageError(
				`bastion binds a name to a target string rather than to a typed Cloudflare binding, so ${name} cannot take a binding list; write \`bindings\` on the site record instead`
			);
		}
		const current = await this.row(name);
		const payload: SiteRow = { ...current, host: name };
		if (settings.tags !== undefined) payload.tags = settings.tags;
		const body = (await this.json('/api/sites', 'POST', payload)) as { site?: SiteRow };
		return settingsOf(body.site ?? payload);
	}

	/** A node does not serve a deployed bundle back; the version id is an address, not a body. */
	async content(name: string): Promise<Response> {
		assertSiteName(name);
		throw new UsageError(
			`a bastion node does not serve a deployed bundle back, so ${name} has no content to read; keep what you deployed, or address the version by its content id`
		);
	}

	async listSecrets(name: string): Promise<SecretSummary[]> {
		assertSiteName(name);
		throw noSecrets(name);
	}

	async putSecret(name: string, _secret: { name: string; text: string }): Promise<void> {
		assertSiteName(name);
		throw noSecrets(name);
	}

	async deleteSecret(name: string, _secretName: string): Promise<void> {
		assertSiteName(name);
		throw noSecrets(name);
	}

	async setTags(name: string, tags: string[]): Promise<string[]> {
		return (await this.patchSettings(name, { tags })).tags;
	}

	/**
	 * Versions of one site, newest first.
	 *
	 * `GET /api/versions` answers for everything the token reaches, so the site filter is on the rows
	 * rather than on a query parameter.
	 */
	async versions(name: string): Promise<BastionVersion[]> {
		assertSiteName(name);
		const body = await this.call<{ versions?: VersionRow[] }>('/api/versions');
		return (body.versions ?? [])
			.map(versionOf)
			.filter((version) => version.site === name)
			.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''));
	}

	/** Points a site at a version it already holds; no new version is created. */
	async deployVersion(name: string, version: string): Promise<BastionDeployment> {
		assertSiteName(name);
		const body = (await this.json(`/api/sites/${name}/deploy`, 'POST', { version })) as {
			deployment?: DeploymentRow;
		};
		return deploymentOf(body.deployment ?? {}, name);
	}

	/**
	 * Sends a share of traffic to one version.
	 *
	 * A real split at the node's own front door, keyed per visitor rather than per request, so a
	 * session stays on one side of it for as long as the rollout lasts.
	 */
	async rollout(name: string, version: string, percent: number): Promise<BastionDeployment> {
		assertSiteName(name);
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
			throw new UsageError(`${percent} is not a share of a rollout; pass 0 to 100`);
		}
		const body = (await this.json(`/api/sites/${name}/rollout`, 'POST', {
			version,
			percent
		})) as { deployment?: DeploymentRow };
		return deploymentOf(body.deployment ?? {}, name);
	}

	/** Moves the pointer back; naming a version picks it, leaving it out takes the previous one. */
	async rollback(name: string, version?: string): Promise<BastionDeployment> {
		assertSiteName(name);
		const body = (await this.json(
			`/api/sites/${name}/rollback`,
			'POST',
			version === undefined ? {} : { version }
		)) as { deployment?: DeploymentRow };
		return deploymentOf(body.deployment ?? {}, name);
	}

	/** The node's own log, which is what `tails` means here: it owns the process that wrote it. */
	async logs(
		options: { site?: string; level?: string; limit?: number } = {}
	): Promise<BastionLogLine[]> {
		const body = await this.call<{ lines?: Record<string, unknown>[] }>('/api/logs', {
			query: { site: options.site, level: options.level, limit: options.limit }
		});
		return (body.lines ?? []).map(logOf);
	}

	/** The Prometheus exposition the node serves; text rather than JSON, so it skips the envelope. */
	async metrics(): Promise<string> {
		const response = await this.http.send('/api/metrics', {
			headers: { accept: 'text/plain' }
		});
		if (response.status >= 400) {
			throw new ApiError(`GET /api/metrics: HTTP ${response.status}`, response.status);
		}
		return response.text();
	}

	private async row(name: string): Promise<SiteRow> {
		assertSiteName(name);
		const body = await this.call<{ sites?: SiteRow[] }>('/api/sites');
		const row = (body.sites ?? []).find((entry) => nameOf(entry) === name);
		if (row === undefined) {
			throw new NotFoundError(`no site named ${name} on ${this.target}`);
		}
		return row;
	}
}

/** the entry a caller uses: `workforce({ plane: workerd({ endpoint, token }) })` */
export function workerd(options: WorkerdOptions): WorkerdPlane {
	return new WorkerdPlane(options);
}
