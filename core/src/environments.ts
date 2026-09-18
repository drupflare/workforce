/**
 * Environments, and forking a Worker into one.
 *
 * A fork copies code, bindings and settings under a new name. What it cannot copy is secrets: the API
 * returns a secret as a type and a name with no value, so a fork either takes them as input or leaves
 * whatever the target already has. It says which it did rather than shipping an empty string.
 *
 * Durable Objects are the other decision, and there are three honest answers rather than one.
 */

import { UsageError } from './client/errors.js';
import type { Plane } from './plane/plane.js';
import type { ModuleSet } from './source.js';
import { type Binding } from './worker/bindings.js';
import { buildUpload, type DurableObjectExport, type UploadMetadata } from './worker/upload.js';

/**
 * What happens to the source's Durable Object namespaces.
 *
 * - `fresh`: the fork declares the same classes and gets its own empty namespaces. The default,
 *   because a new environment usually wants its own data.
 * - `shared`: the fork's bindings carry `script_name` pointing at the source, so both Workers address
 *   one namespace. Useful for a read-only preview of live data, and dangerous for anything that
 *   writes.
 * - `transfer`: the namespace MOVES. The target declares `expecting-transfer` and the source declares
 *   `transferred`, in two deploys. This is not a copy, and the source loses the data.
 */
export type DurableObjectMode = 'fresh' | 'shared' | 'transfer';

export interface ForkInput {
	source: string;
	target: string;
	modules: ModuleSet;
	metadata?: Omit<UploadMetadata, 'main_module'>;
	main?: string;
	durableObjects?: DurableObjectMode;
	/** secrets to set on the fork; without these the fork has none, because the API hides them */
	secrets?: Record<string, string>;
	/** required for `transfer`, because it destroys the source's copy */
	confirmTransfer?: boolean;
}

export interface ForkPlan {
	target: string;
	upload: ReturnType<typeof buildUpload>;
	durableObjects: DurableObjectMode;
	/** secret names the source had that the fork will not have unless they are supplied */
	secretsNotCarried: string[];
	/** the second deploy a transfer needs, which the caller performs against the source */
	sourceFollowUp: { script: string; exports: Record<string, DurableObjectExport> } | null;
}

function classesOf(metadata: UploadMetadata | undefined): string[] {
	return Object.entries(metadata?.exports ?? {})
		.filter(([, declared]) => declared.type === 'durable-object')
		.map(([name]) => name);
}

/**
 * Rewrites the Durable Object declarations for the chosen mode.
 *
 * `shared` is the one that changes bindings rather than exports: a Worker that does not declare the
 * class but binds to another script's namespace is the cross-script shape.
 */
export function forkDurableObjects(
	mode: DurableObjectMode,
	sourceName: string,
	metadata: UploadMetadata
): { metadata: UploadMetadata; followUp: ForkPlan['sourceFollowUp'] } {
	const classes = classesOf(metadata);
	if (classes.length === 0 || mode === 'fresh') return { metadata, followUp: null };

	if (mode === 'shared') {
		const bindings: Binding[] = (metadata.bindings ?? []).map((binding) =>
			binding.type === 'durable_object_namespace' && binding.script_name === undefined
				? { ...binding, script_name: sourceName }
				: binding
		);
		// the fork addresses the source's namespaces, so it must not declare the classes itself
		const { exports: _dropped, ...rest } = metadata;
		return { metadata: { ...rest, bindings }, followUp: null };
	}

	const expecting: Record<string, DurableObjectExport> = {};
	const transferred: Record<string, DurableObjectExport> = {};
	for (const name of classes) {
		const declared = metadata.exports?.[name] as DurableObjectExport;
		expecting[name] = { ...declared, state: 'expecting-transfer', transfer_from: sourceName };
		transferred[name] = { type: 'durable-object', state: 'transferred', transferred_to: '' };
	}
	return {
		metadata: { ...metadata, exports: expecting },
		followUp: { script: sourceName, exports: transferred }
	};
}

/**
 * Prepares a fork without performing it.
 *
 * Separated so a caller can show what is about to happen, and so the refusal for an unconfirmed
 * transfer arrives before anything is uploaded.
 */
export function planFork(input: ForkInput, sourceSecretNames: readonly string[] = []): ForkPlan {
	const mode = input.durableObjects ?? 'fresh';
	if (mode === 'transfer' && input.confirmTransfer !== true) {
		throw new UsageError(
			'a transfer MOVES the Durable Object namespace and its data off the source; pass confirmTransfer to mean it'
		);
	}
	if (input.source === input.target) {
		throw new UsageError('a fork needs a different name than its source');
	}

	const base: UploadMetadata = { ...input.metadata };
	const { metadata, followUp } = forkDurableObjects(mode, input.source, base);

	const supplied = new Set(Object.keys(input.secrets ?? {}));
	return {
		target: input.target,
		durableObjects: mode,
		secretsNotCarried: sourceSecretNames.filter((name) => !supplied.has(name)),
		sourceFollowUp:
			followUp === null
				? null
				: {
						script: followUp.script,
						exports: Object.fromEntries(
							Object.entries(followUp.exports).map(([name, declared]) => [
								name,
								{ ...declared, transferred_to: input.target }
							])
						)
					},
		upload: buildUpload({ source: input.modules, main: input.main, metadata })
	};
}

/** the conventional name for one environment of a Worker */
export function environmentName(worker: string, environment: string): string {
	return environment === 'production' ? worker : `${worker}-${environment}`;
}

export interface PromoteInput {
	from: string;
	to: string;
	plane: Plane;
	modules: ModuleSet;
	metadata?: Omit<UploadMetadata, 'main_module'>;
	main?: string;
}

/**
 * Promotion is a fork pointed at an existing name.
 *
 * Durable Objects stay `fresh` here on purpose: promoting code should not move the target's data, and
 * a target that already exists already has its own namespaces.
 */
export function planPromotion(input: PromoteInput): ForkPlan {
	return planFork({
		source: input.from,
		target: input.to,
		modules: input.modules,
		metadata: input.metadata,
		main: input.main,
		durableObjects: 'fresh'
	});
}
