/**
 * Versions, deployments, rollback and revert.
 *
 * Four guards live here, and each names the mechanism rather than relaying a 400. They exist because
 * every one of them is a documented platform refusal a caller would otherwise meet as an opaque
 * error late in a rollout.
 */

import { UsageError } from './client/errors.js';
import type { HttpClient } from './client/fetch.js';
import { collect } from './client/paginate.js';
import { requireCapability, type Plane } from './plane/plane.js';
import type { Binding } from './worker/bindings.js';
import { carriesLifecycleChange, type BuiltUpload, type UploadMetadata } from './worker/upload.js';

/**
 * Only the 100 most recent versions are reachable.
 *
 * Recorded in `drupflare/worker/docs/php-update-delivery.md:169`. Past that a version id still exists
 * and still cannot be deployed, which is the shape of failure worth catching early.
 */
export const REACHABLE_VERSIONS = 100;

export interface WorkerVersion {
	id: string;
	number: number;
	createdOn: string | null;
	/** the plane's own content hash, which is how a version workforce did not make is spotted */
	etag: string | null;
	message: string | null;
	tag: string | null;
	bindings: Binding[];
	compatibilityDate: string | null;
	compatibilityFlags: string[];
}

export interface DeploymentSlice {
	version: string;
	percentage: number;
}

export interface Deployment {
	id: string;
	createdOn: string | null;
	strategy: string;
	versions: DeploymentSlice[];
}

interface VersionRow {
	id?: string;
	number?: number;
	metadata?: { created_on?: string; source?: string };
	annotations?: Record<string, string>;
	resources?: {
		bindings?: Binding[];
		script?: { etag?: string };
		script_runtime?: { compatibility_date?: string; compatibility_flags?: string[] };
	};
}

function versionOf(row: VersionRow): WorkerVersion {
	return {
		id: String(row.id ?? ''),
		number: row.number ?? 0,
		createdOn: row.metadata?.created_on ?? null,
		etag: row.resources?.script?.etag ?? null,
		message: row.annotations?.['workers/message'] ?? null,
		tag: row.annotations?.['workers/tag'] ?? null,
		bindings: row.resources?.bindings ?? [],
		compatibilityDate: row.resources?.script_runtime?.compatibility_date ?? null,
		compatibilityFlags: row.resources?.script_runtime?.compatibility_flags ?? []
	};
}

export interface CreateVersionInput {
	upload: BuiltUpload;
	/** `workers/message`, which the dashboard shows beside the version */
	message?: string;
	/** `workers/tag`, which is where a parent version id or a source ref is carried */
	tag?: string;
}

/**
 * Refuses a version upload the platform will refuse.
 *
 * Cloudflare rejects a version carrying a Durable Object lifecycle change, because a lifecycle change
 * is atomic at the control plane and a version is not: applying a delete to half the objects would
 * fail every request that reached one of them.
 */
export function assertVersionable(metadata: UploadMetadata): void {
	if (carriesLifecycleChange(metadata)) {
		throw new UsageError(
			'this upload changes a Durable Object lifecycle, which cannot be uploaded as a version: lifecycle changes are atomic at the control plane. Deploy it directly instead, on its own.'
		);
	}
}

/**
 * Refuses a gradual deployment the platform will refuse.
 *
 * Gradual deployments are not supported for a Worker configured with `exports`, for the same reason:
 * the split has nothing to split a lifecycle across.
 */
export function assertGradualAllowed(
	slices: readonly DeploymentSlice[],
	metadata: UploadMetadata | null
): void {
	const gradual = slices.length > 1;
	if (!gradual) return;
	if (metadata !== null && metadata.exports !== undefined) {
		throw new UsageError(
			'a gradual deployment is not supported on a Worker configured with exports; deploy one version at 100 percent'
		);
	}
}

/** Refuses percentages that do not make a deployment. */
export function assertSlices(slices: readonly DeploymentSlice[]): void {
	if (slices.length === 0) throw new UsageError('a deployment needs at least one version');
	for (const slice of slices) {
		if (slice.percentage < 0 || slice.percentage > 100) {
			throw new UsageError(
				`${slice.version} is at ${slice.percentage} percent, which is not a share of a deployment`
			);
		}
	}
	const total = slices.reduce((n, s) => n + s.percentage, 0);
	if (Math.abs(total - 100) > 0.01) {
		throw new UsageError(`deployment percentages total ${total}, and they have to total 100`);
	}
}

/**
 * Refuses a rollback past what the platform still holds.
 *
 * The version id may be perfectly real and still be unreachable, so this is checked against the list
 * rather than against the id's shape.
 */
export function assertReachable(versions: readonly WorkerVersion[], id: string): void {
	const at = versions.findIndex((v) => v.id === id);
	if (at === -1) {
		throw new UsageError(
			`version ${id} is not among the ${versions.length} versions this Worker still has; only the ${REACHABLE_VERSIONS} most recent are reachable`
		);
	}
	if (at >= REACHABLE_VERSIONS) {
		throw new UsageError(
			`version ${id} is ${at + 1} versions back, and only the ${REACHABLE_VERSIONS} most recent are reachable`
		);
	}
}

/**
 * Refuses a rollback that would cross a Durable Object lifecycle change.
 *
 * A lifecycle change is not reversible by re-pointing a deployment: the namespace it created, renamed
 * or deleted does not come back when an older version serves traffic again.
 */
export function assertNoLifecycleCrossing(
	versions: readonly WorkerVersion[],
	fromId: string,
	toId: string,
	lifecycleVersionIds: ReadonlySet<string>
): void {
	const from = versions.findIndex((v) => v.id === fromId);
	const to = versions.findIndex((v) => v.id === toId);
	if (from === -1 || to === -1) return;
	const [newer, older] = from < to ? [from, to] : [to, from];
	for (let at = newer; at < older; at += 1) {
		const version = versions[at];
		if (version !== undefined && lifecycleVersionIds.has(version.id)) {
			throw new UsageError(
				`rolling back across version ${version.id} would cross a Durable Object lifecycle change, which re-pointing a deployment cannot undo`
			);
		}
	}
}

/** The versions and deployments surface for one Worker on one plane. */
export class VersionsApi {
	constructor(
		private readonly plane: Plane,
		private readonly name: string,
		private readonly http: HttpClient,
		private readonly base: string
	) {}

	private path(rest = ''): string {
		return `${this.base}/scripts/${this.name}${rest}`;
	}

	async list(options: { limit?: number } = {}): Promise<WorkerVersion[]> {
		requireCapability(this.plane, 'versions');
		const rows = await collect<VersionRow>(this.http, this.path('/versions'), {
			limit: options.limit
		});
		return rows.map(versionOf);
	}

	async get(id: string): Promise<WorkerVersion> {
		requireCapability(this.plane, 'versions');
		return versionOf(await this.http.request<VersionRow>(this.path(`/versions/${id}`)));
	}

	/**
	 * Uploads a version without deploying it.
	 *
	 * The annotations are where ancestry lives: a parent version id in `workers/tag` is what lets a
	 * later `log()` walk the chain without a store of its own.
	 */
	async create(input: CreateVersionInput): Promise<WorkerVersion> {
		requireCapability(this.plane, 'versions');
		assertVersionable(input.upload.metadata);

		const annotations: Record<string, string> = {};
		if (input.message !== undefined) annotations['workers/message'] = input.message;
		if (input.tag !== undefined) annotations['workers/tag'] = input.tag;

		if (Object.keys(annotations).length > 0) {
			const metadata = input.upload.body.get('metadata');
			if (typeof metadata === 'string') {
				const parsed = JSON.parse(metadata) as UploadMetadata;
				input.upload.body.set(
					'metadata',
					JSON.stringify({
						...parsed,
						annotations: { ...parsed.annotations, ...annotations }
					})
				);
			}
		}

		return versionOf(
			await this.http.request<VersionRow>(this.path('/versions'), {
				method: 'POST',
				body: input.upload.body
			})
		);
	}

	async deployments(): Promise<Deployment[]> {
		requireCapability(this.plane, 'deployments');
		const result = await this.http.request<{ deployments?: unknown[] } | unknown[]>(
			this.path('/deployments')
		);
		const rows = Array.isArray(result)
			? result
			: ((result as { deployments?: unknown[] }).deployments ?? []);
		return (rows as Record<string, unknown>[]).map((row) => ({
			id: String(row.id ?? ''),
			createdOn: (row.created_on as string) ?? (row.createdOn as string) ?? null,
			strategy: String(row.strategy ?? 'percentage'),
			versions: ((row.versions ?? []) as { version_id?: string; percentage?: number }[]).map(
				(v) => ({ version: String(v.version_id ?? ''), percentage: v.percentage ?? 0 })
			)
		}));
	}

	/**
	 * Points traffic at one or more versions.
	 *
	 * Under a gradual deployment, requests to a given Durable Object use the same version for the life
	 * of that deployment. So a 10 percent split puts roughly 10 percent of OBJECTS wholly on the new
	 * code rather than 10 percent of each object's requests, which is a per-object canary and is not
	 * reproducible at the application layer.
	 */
	async deploy(
		slices: DeploymentSlice[] | string,
		options: { metadata?: UploadMetadata | null } = {}
	): Promise<Deployment> {
		requireCapability(this.plane, 'deployments');
		const resolved =
			typeof slices === 'string' ? [{ version: slices, percentage: 100 }] : slices;
		assertSlices(resolved);
		assertGradualAllowed(resolved, options.metadata ?? null);

		const created = await this.http.request<Record<string, unknown>>(
			this.path('/deployments'),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					strategy: 'percentage',
					versions: resolved.map((s) => ({
						version_id: s.version,
						percentage: s.percentage
					}))
				})
			}
		);
		return {
			id: String(created.id ?? ''),
			createdOn: (created.created_on as string) ?? null,
			strategy: String(created.strategy ?? 'percentage'),
			versions: resolved
		};
	}

	/**
	 * Re-points the deployment at a version the plane still holds.
	 *
	 * This is `git reset`: no new version is created and the version list does not grow. See
	 * `revert()` for the other one.
	 */
	async rollback(
		id: string,
		options: { lifecycleVersionIds?: ReadonlySet<string> } = {}
	): Promise<Deployment> {
		requireCapability(this.plane, 'deployments');
		const versions = await this.list();
		assertReachable(versions, id);
		const current = versions[0];
		if (current !== undefined && options.lifecycleVersionIds !== undefined) {
			assertNoLifecycleCrossing(versions, current.id, id, options.lifecycleVersionIds);
		}
		return this.deploy(id);
	}
}
