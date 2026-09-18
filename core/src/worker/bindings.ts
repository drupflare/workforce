/**
 * The binding union, and the differ that keeps a patch from wiping what it did not mention.
 *
 * Every binding Cloudflare accepts in upload metadata is here as a discriminated union on `type`, so
 * a caller gets the required fields checked rather than discovering them in a 400.
 */

import { UsageError } from '../client/errors.js';

export interface BindingBase {
	name: string;
}

export type Binding =
	| (BindingBase & { type: 'ai' })
	| (BindingBase & { type: 'analytics_engine'; dataset: string })
	| (BindingBase & { type: 'assets' })
	| (BindingBase & { type: 'browser_rendering' })
	| (BindingBase & { type: 'd1'; id: string })
	| (BindingBase & { type: 'data_blob'; part: string })
	| (BindingBase & { type: 'dispatch_namespace'; namespace: string; outbound?: unknown })
	| (BindingBase & {
			type: 'durable_object_namespace';
			class_name: string;
			/** the Worker that owns the class, when it is not this one */
			script_name?: string;
			environment?: string;
			namespace_id?: string;
	  })
	| (BindingBase & { type: 'hyperdrive'; id: string })
	| (BindingBase & { type: 'images' })
	| (BindingBase & { type: 'inherit'; old_name?: string })
	| (BindingBase & { type: 'json'; json: unknown })
	| (BindingBase & { type: 'kv_namespace'; namespace_id: string })
	| (BindingBase & { type: 'mtls_certificate'; certificate_id: string })
	| (BindingBase & { type: 'pipelines'; pipeline: string })
	| (BindingBase & { type: 'plain_text'; text: string })
	| (BindingBase & { type: 'queue'; queue_name: string })
	| (BindingBase & { type: 'ratelimit'; namespace_id: string; simple: unknown })
	| (BindingBase & { type: 'r2_bucket'; bucket_name: string; jurisdiction?: string })
	| (BindingBase & { type: 'secret_text'; text: string })
	| (BindingBase & { type: 'secrets_store_secret'; store_id: string; secret_name: string })
	| (BindingBase & { type: 'send_email'; destination_address?: string })
	| (BindingBase & { type: 'service'; service: string; environment?: string })
	| (BindingBase & { type: 'text_blob'; part: string })
	| (BindingBase & { type: 'vectorize'; index_name: string })
	| (BindingBase & { type: 'version_metadata' })
	| (BindingBase & { type: 'wasm_module'; part: string })
	| (BindingBase & {
			type: 'workflow';
			workflow_name: string;
			class_name: string;
			script_name?: string;
	  });

export type BindingType = Binding['type'];

/** bindings whose value the API will not read back, so a round trip cannot preserve them */
export const OPAQUE_BINDING_TYPES: ReadonlySet<BindingType> = new Set([
	'secret_text',
	'secrets_store_secret'
]);

/**
 * Whether a binding read back from the API still carries its value.
 *
 * `GET /settings` returns a secret as `{type: 'secret_text', name}` with no `text`, so a fork or a
 * patch built from a read cannot carry secrets forward and has to say so rather than silently
 * shipping an empty string.
 */
export function isOpaque(binding: Binding): boolean {
	if (!OPAQUE_BINDING_TYPES.has(binding.type)) return false;
	if (binding.type === 'secret_text')
		return typeof binding.text !== 'string' || binding.text === '';
	return false;
}

const REQUIRED: Partial<Record<BindingType, readonly string[]>> = {
	analytics_engine: ['dataset'],
	d1: ['id'],
	data_blob: ['part'],
	dispatch_namespace: ['namespace'],
	durable_object_namespace: ['class_name'],
	hyperdrive: ['id'],
	json: ['json'],
	kv_namespace: ['namespace_id'],
	mtls_certificate: ['certificate_id'],
	pipelines: ['pipeline'],
	plain_text: ['text'],
	queue: ['queue_name'],
	r2_bucket: ['bucket_name'],
	ratelimit: ['namespace_id', 'simple'],
	secret_text: ['text'],
	secrets_store_secret: ['store_id', 'secret_name'],
	service: ['service'],
	text_blob: ['part'],
	vectorize: ['index_name'],
	wasm_module: ['part'],
	workflow: ['workflow_name', 'class_name']
};

/** Refuses a binding the API would reject, naming the field rather than relaying a 400. */
export function assertBinding(binding: Binding): void {
	if (typeof binding.name !== 'string' || binding.name === '') {
		throw new UsageError(`a ${binding.type} binding has no name`);
	}
	for (const field of REQUIRED[binding.type] ?? []) {
		if ((binding as unknown as Record<string, unknown>)[field] === undefined) {
			throw new UsageError(`the ${binding.type} binding ${binding.name} needs ${field}`);
		}
	}
}

export function assertBindings(bindings: readonly Binding[]): void {
	const seen = new Set<string>();
	for (const binding of bindings) {
		assertBinding(binding);
		if (seen.has(binding.name)) {
			throw new UsageError(`two bindings are both named ${binding.name}`);
		}
		seen.add(binding.name);
	}
}

/** `{type: 'inherit'}` keeps whatever the deployed Worker already has under this name */
export function inherit(name: string, oldName?: string): Binding {
	return oldName === undefined
		? { type: 'inherit', name }
		: { type: 'inherit', name, old_name: oldName };
}

export interface BindingDiff {
	added: Binding[];
	changed: { before: Binding; after: Binding }[];
	removed: Binding[];
	/** names present on both sides whose value could not be compared because the API hides it */
	opaque: string[];
}

function sameBinding(a: Binding, b: Binding): boolean {
	if (a.type !== b.type) return false;
	return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

function sortedEntries(value: Binding): [string, unknown][] {
	return Object.entries(value as unknown as Record<string, unknown>).sort(([x], [y]) =>
		x.localeCompare(y)
	);
}

/**
 * Compares two binding sets by name.
 *
 * A secret present on both sides lands in `opaque` rather than in `changed`, because the API never
 * returned its value and "differs" would be a guess. A caller deciding whether a patch is a no-op
 * has to see that distinction.
 */
export function diffBindings(before: readonly Binding[], after: readonly Binding[]): BindingDiff {
	const byName = new Map(before.map((b) => [b.name, b]));
	const diff: BindingDiff = { added: [], changed: [], removed: [], opaque: [] };

	for (const next of after) {
		const previous = byName.get(next.name);
		if (previous === undefined) {
			diff.added.push(next);
			continue;
		}
		byName.delete(next.name);
		if (isOpaque(previous) || isOpaque(next)) {
			diff.opaque.push(next.name);
			continue;
		}
		if (!sameBinding(previous, next)) diff.changed.push({ before: previous, after: next });
	}

	for (const remaining of byName.values()) diff.removed.push(remaining);
	return diff;
}

/**
 * The binding list for a PATCH that changes some bindings and keeps the rest.
 *
 * A settings PATCH replaces the whole list, so sending only what changed deletes everything else.
 * This is the call that stops that: every name not being changed comes back as `inherit`.
 */
export function patchBindings(current: readonly Binding[], changes: readonly Binding[]): Binding[] {
	// validate the incoming list BEFORE it becomes a map, because keying by name collapses a
	// duplicate into a silent last-wins instead of the refusal the caller should get
	assertBindings(changes);
	const changed = new Map(changes.map((b) => [b.name, b]));
	const out: Binding[] = [];
	for (const existing of current) {
		const replacement = changed.get(existing.name);
		if (replacement !== undefined) {
			out.push(replacement);
			changed.delete(existing.name);
		} else {
			out.push(inherit(existing.name));
		}
	}
	for (const added of changed.values()) out.push(added);
	assertBindings(out);
	return out;
}
