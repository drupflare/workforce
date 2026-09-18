/**
 * What the local plane remembers.
 *
 * Kept apart from the HTTP surface so a spec can assert against the state directly rather than
 * reading it back through the API it is testing.
 */

export interface StoredVersion {
	id: string;
	number: number;
	createdOn: string;
	etag: string;
	metadata: Record<string, unknown>;
	modules: Map<string, Uint8Array>;
	annotations: Record<string, string>;
}

export interface StoredDeployment {
	id: string;
	createdOn: string;
	strategy: string;
	versions: { version_id: string; percentage: number }[];
}

export interface StoredScript {
	name: string;
	id: string;
	createdOn: string;
	modifiedOn: string;
	tags: string[];
	settings: Record<string, unknown>;
	secrets: Map<string, string>;
	versions: StoredVersion[];
	deployments: StoredDeployment[];
	subdomainEnabled: boolean;
	/** the port a `wrangler dev` is listening on for this script, when one was started */
	port: number | null;
	assets: Map<string, Uint8Array>;
}

export interface StoredNamespace {
	name: string;
	createdOn: string;
	scripts: Map<string, StoredScript>;
}

export interface StoredAccessApp {
	id: string;
	name: string;
	destinations: { type: string; worker_id?: string }[];
}

export interface StoredAssetSession {
	jwt: string;
	buckets: string[][];
	/** hashes the session still expects, so a completion before they arrive is refused */
	pending: Set<string>;
	completed: boolean;
	createdAtMs: number;
}

export class PlaneState {
	readonly scripts = new Map<string, StoredScript>();
	readonly namespaces = new Map<string, StoredNamespace>();
	readonly accessApps = new Map<string, StoredAccessApp>();
	readonly assetSessions = new Map<string, StoredAssetSession>();
	readonly uploadedAssets = new Map<string, Uint8Array>();
	readonly d1 = new Map<string, { uuid: string; name: string }>();
	readonly kv = new Map<string, { id: string; title: string }>();
	readonly r2 = new Map<string, { name: string }>();
	/** every request the plane answered, so a spec can assert on call shape */
	readonly log: { method: string; path: string }[] = [];

	private counter = 0;

	id(prefix: string): string {
		this.counter += 1;
		return `${prefix}-${this.counter.toString(16).padStart(8, '0')}`;
	}

	reset(): void {
		this.scripts.clear();
		this.namespaces.clear();
		this.accessApps.clear();
		this.assetSessions.clear();
		this.uploadedAssets.clear();
		this.d1.clear();
		this.kv.clear();
		this.r2.clear();
		this.log.length = 0;
		this.counter = 0;
	}
}
