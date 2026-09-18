/**
 * What an executor is.
 *
 * The control plane's job is the same whichever way a Worker is hosted: provision, update, inspect,
 * monitor, repair. Only the executor underneath changes. So this is one interface with three
 * implementations, and what a given executor cannot do is declared rather than discovered.
 */

import { CapabilityError } from '../client/errors.js';
import type { HttpClient } from '../client/fetch.js';
import type { Binding } from '../worker/bindings.js';
import type { BuiltUpload, UploadMetadata } from '../worker/upload.js';

/** what a plane can do, and the reason when it cannot */
export interface Capability {
	readonly supported: boolean;
	readonly reason: string;
}

export const CAN: Capability = { supported: true, reason: '' };

export function cannot(reason: string): Capability {
	return { supported: false, reason };
}

export interface PlaneCapabilities {
	/** `POST /versions`, and everything that addresses a version id */
	readonly versions: Capability;
	/** `POST /deployments`, including a percentage split */
	readonly deployments: Capability;
	/** a `workers.dev` hostname */
	readonly subdomain: Capability;
	/** cron triggers */
	readonly schedules: Capability;
	/** `POST /tails`, the live log socket */
	readonly tails: Capability;
	/** the observability query API and analytics */
	readonly analytics: Capability;
	/** static asset upload sessions */
	readonly assets: Capability;
	/** Cloudflare Access applications over the Worker */
	readonly access: Capability;
	/** routes and custom domains */
	readonly routes: Capability;
	/** tags, and how many are allowed */
	readonly tags: Capability;
	/** the most tags one script may carry, or null where there is no cap */
	readonly maxTags: number | null;
}

/** one Worker as a plane reports it */
export interface WorkerSummary {
	name: string;
	/** Cloudflare's own id for the script, which its Access and analytics APIs key on */
	id: string | null;
	createdOn: string | null;
	modifiedOn: string | null;
	tags: string[];
}

export interface WorkerSettings {
	bindings: Binding[];
	compatibilityDate: string | null;
	compatibilityFlags: string[];
	tags: string[];
	logpush: boolean | null;
	observability: { enabled: boolean; head_sampling_rate?: number } | null;
	/** whatever else the plane reported, so nothing is lost on a round trip */
	raw: Record<string, unknown>;
}

export interface UploadResult {
	name: string;
	/** the version this upload produced, where the plane has versions */
	versionId: string | null;
	/** the plane's own hash of the content, used to spot a deploy workforce did not make */
	etag: string | null;
	metadata: UploadMetadata;
}

export interface SecretSummary {
	name: string;
	type: string;
}

/**
 * The operations every executor has.
 *
 * Anything a particular executor cannot do is absent from here and reached through a capability
 * instead, so this interface stays the set of things that work everywhere.
 */
export interface Plane {
	readonly kind: 'cloudflare' | 'dispatch' | 'workerd';
	/** what this plane is, for an error message: an account id, a namespace, an endpoint */
	readonly target: string;
	readonly capabilities: PlaneCapabilities;
	/** the credential this plane spends against, so a hub can share one budget across planes */
	readonly credentialKey: string;
	readonly http: HttpClient;

	list(options?: { limit?: number }): Promise<WorkerSummary[]>;
	get(name: string): Promise<WorkerSummary | null>;
	exists(name: string): Promise<boolean>;
	upload(name: string, upload: BuiltUpload): Promise<UploadResult>;
	delete(name: string): Promise<void>;
	settings(name: string): Promise<WorkerSettings>;
	patchSettings(name: string, settings: Partial<WorkerSettings>): Promise<WorkerSettings>;
	/** the deployed modules, where the plane can return them */
	content(name: string): Promise<Response>;
	listSecrets(name: string): Promise<SecretSummary[]>;
	putSecret(name: string, secret: { name: string; text: string }): Promise<void>;
	deleteSecret(name: string, secretName: string): Promise<void>;
	setTags(name: string, tags: string[]): Promise<string[]>;
}

/** Throws a {@link CapabilityError} unless the plane supports this. */
export function requireCapability(
	plane: Pick<Plane, 'kind' | 'capabilities'>,
	name: keyof Omit<PlaneCapabilities, 'maxTags'>
): void {
	const capability = plane.capabilities[name];
	if (!capability.supported) {
		throw new CapabilityError(plane.kind, name, capability.reason);
	}
}
