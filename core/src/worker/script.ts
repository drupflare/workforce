/**
 * One Worker, on whichever plane the client was built with.
 *
 * A handle rather than a record: it holds a name and a plane and does nothing until asked, so getting
 * one is free and holding a stale one is not a correctness problem.
 */

import { assetsApi, syncAssets, type SyncResult } from '../assets.js';
import { NotFoundError } from '../client/errors.js';
import type {
	Plane,
	SecretSummary,
	UploadResult,
	WorkerSettings,
	WorkerSummary
} from '../plane/plane.js';
import { requireCapability } from '../plane/plane.js';
import { fromUtf8, type ModuleSet } from '../source.js';
import { VersionsApi } from '../versions.js';
import { patchBindings, type Binding } from './bindings.js';
import { buildUpload, type UploadInput } from './upload.js';

export interface WorkerUploadInput extends Omit<UploadInput, 'source'> {
	source: ModuleSet;
}

export class WorkerHandle {
	constructor(
		readonly plane: Plane,
		readonly name: string
	) {}

	async get(): Promise<WorkerSummary | null> {
		return this.plane.get(this.name);
	}

	async exists(): Promise<boolean> {
		return this.plane.exists(this.name);
	}

	/** the summary, or a named refusal rather than a null the caller has to remember to check */
	async require(): Promise<WorkerSummary> {
		const summary = await this.plane.get(this.name);
		if (summary === null) {
			throw new NotFoundError(`no Worker named ${this.name} on ${this.plane.target}`);
		}
		return summary;
	}

	async upload(input: WorkerUploadInput): Promise<UploadResult> {
		return this.plane.upload(this.name, buildUpload(input));
	}

	async delete(): Promise<void> {
		await this.plane.delete(this.name);
	}

	async settings(): Promise<WorkerSettings> {
		return this.plane.settings(this.name);
	}

	/**
	 * Changes some settings and keeps the rest.
	 *
	 * Bindings need care here: the API replaces the whole list, so a patch naming two bindings
	 * deletes every other one. {@link patchBindings} turns the rest into `inherit` entries, which is
	 * why this reads the current settings first.
	 */
	async patchSettings(
		changes: Partial<WorkerSettings> & { bindings?: Binding[] }
	): Promise<WorkerSettings> {
		if (changes.bindings === undefined) {
			return this.plane.patchSettings(this.name, changes);
		}
		const current = await this.plane.settings(this.name);
		return this.plane.patchSettings(this.name, {
			...changes,
			bindings: patchBindings(current.bindings, changes.bindings)
		});
	}

	/** replaces the binding list outright, for a caller that means to */
	async replaceBindings(bindings: Binding[]): Promise<WorkerSettings> {
		return this.plane.patchSettings(this.name, { bindings });
	}

	async content(): Promise<Response> {
		return this.plane.content(this.name);
	}

	async tags(): Promise<string[]> {
		return (await this.require()).tags;
	}

	async setTags(tags: string[]): Promise<string[]> {
		return this.plane.setTags(this.name, tags);
	}

	readonly secrets = {
		list: (): Promise<SecretSummary[]> => this.plane.listSecrets(this.name),
		put: (name: string, text: string | Uint8Array): Promise<void> =>
			this.plane.putSecret(this.name, {
				name,
				text: typeof text === 'string' ? text : new TextDecoder().decode(text)
			}),
		/** serialises for the caller, so nobody hand-rolls JSON.stringify at every call site */
		putJson: (name: string, value: unknown): Promise<void> =>
			this.plane.putSecret(this.name, { name, text: JSON.stringify(value) }),
		delete: (name: string): Promise<void> => this.plane.deleteSecret(this.name, name)
	};

	/**
	 * Versions, deployments, rollback.
	 *
	 * Capability-gated: reaching for this on a plane without versions throws a named
	 * `CapabilityError` rather than producing a 404 the caller has to interpret.
	 */
	get versions(): VersionsApi {
		// refuse here rather than handing back an object whose every method throws
		requireCapability(this.plane, 'versions');
		const accountBase = (this.plane as unknown as { base?: string }).base;
		if (accountBase === undefined) {
			throw new Error(`the ${this.plane.kind} plane exposes no script base path`);
		}
		return new VersionsApi(this.plane, this.name, this.plane.http, accountBase);
	}

	/** convenience: deploy one version at 100 percent */
	async deploy(version: string): Promise<void> {
		await this.versions.deploy(version);
	}

	async rollback(version: string): Promise<void> {
		await this.versions.rollback(version);
	}

	readonly assets = {
		/**
		 * Uploads a whole asset tree; anything absent from it is deleted.
		 *
		 * There is deliberately no `patch` here. See `assets.ts` for why an incomplete manifest
		 * carries removed paths forward instead of deleting them.
		 */
		sync: (tree: ModuleSet): Promise<SyncResult> => {
			requireCapability(this.plane, 'assets');
			const accountId = (this.plane as unknown as { accountId?: string }).accountId ?? '';
			const base = (this.plane as unknown as { base?: string }).base ?? '';
			return syncAssets(
				assetsApi(
					this.plane.http,
					accountId,
					`${base}/scripts/${this.name}/assets-upload-session`
				),
				tree
			);
		}
	};

	/** @internal used by the revision store to hash what was uploaded */
	_encode(value: string): Uint8Array {
		return fromUtf8(value);
	}
}
