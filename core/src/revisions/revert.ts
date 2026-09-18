/**
 * `revert` and `rollback`, which are different operations and the difference is the point.
 *
 * `rollback` re-points the deployment at a version the plane still holds. No new version appears and
 * the version list does not grow. It is `git reset`, and it is bounded twice over: only the 100 most
 * recent versions are reachable, and it cannot cross a Durable Object lifecycle change.
 *
 * `revert` uploads the stored content of an old version as a NEW version and deploys that. History
 * moves forward rather than backward, which is what the next person to deploy expects to see. It is
 * `git revert`, and it is bounded instead by whether the store still holds the content.
 */

import { UsageError } from '../client/errors.js';
import type { ModuleSet } from '../source.js';
import type { BuiltUpload, UploadMetadata } from '../worker/upload.js';
import { buildUpload } from '../worker/upload.js';
import { RevisionStore, type Revision } from './store.js';

export interface RevertPlan {
	/** the revision whose content is being restored */
	revision: Revision;
	modules: ModuleSet;
	upload: BuiltUpload;
	message: string;
}

export interface RevertOptions {
	/** metadata for the new version; defaults to what the revision was uploaded with */
	metadata?: Omit<UploadMetadata, 'main_module'>;
	message?: string;
}

/**
 * Prepares the new version a revert would create.
 *
 * Separated from performing it so a caller can show what is about to happen, and so the refusal for a
 * revision whose content is gone arrives before anything is deployed.
 */
export async function planRevert(
	store: RevisionStore,
	worker: string,
	revisionId: string,
	options: RevertOptions = {}
): Promise<RevertPlan> {
	const revision = await store.get(worker, revisionId);
	if (revision === null) {
		throw new UsageError(
			`no stored revision ${revisionId} for ${worker}; a revert rebuilds content, and the platform cannot return an old version's modules`
		);
	}

	const modules = await store.read(worker, revisionId);
	const main = String(
		(revision.files.find((f) => f.path.endsWith('.js'))?.path ?? 'index.js') as string
	);

	const message =
		options.message ??
		`revert to ${revision.versionId ?? revision.id.slice(0, 12)}${
			revision.label === null ? '' : ` (${revision.label})`
		}`;

	return {
		revision,
		modules,
		message,
		upload: buildUpload({
			source: modules,
			main: modules.has('index.js') ? 'index.js' : main,
			metadata: options.metadata
		})
	};
}
