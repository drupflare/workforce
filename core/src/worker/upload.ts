/**
 * The multipart body a Worker upload is.
 *
 * Cloudflare takes a `multipart/form-data` request whose `metadata` part is JSON naming the entry
 * point and everything about the Worker, with one further part per module. The shapes here follow
 * that document rather than inventing a friendlier one, because a field this gets wrong surfaces as a
 * 400 with no hint which key was at fault.
 *
 * @see https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
 */

import { UsageError } from '../client/errors.js';
import {
	asBinary,
	MODULE_CONTENT_TYPE,
	moduleTypeOf,
	normalisePath,
	type ModuleSet,
	type ModuleType
} from '../source.js';
import { assertBindings, type Binding } from './bindings.js';

/** how a Durable Object class is declared on a modern Worker */
export type DurableObjectState =
	'created' | 'deleted' | 'renamed' | 'transferred' | 'expecting-transfer';

export interface DurableObjectExport {
	type: 'durable-object';
	storage?: 'sqlite' | 'legacy-kv';
	state?: DurableObjectState;
	renamed_to?: string;
	/** the Worker this namespace is moving to */
	transferred_to?: string;
	/** the Worker this namespace is arriving from */
	transfer_from?: string;
}

/** the legacy imperative form; mutually exclusive with {@link UploadMetadata.exports} */
export interface Migration {
	tag?: string;
	old_tag?: string;
	new_tag?: string;
	new_classes?: string[];
	new_sqlite_classes?: string[];
	renamed_classes?: { from: string; to: string }[];
	deleted_classes?: string[];
	transferred_classes?: { from: string; from_script: string; to: string }[];
}

/**
 * What the upload API takes: one object whose steps apply in order after `old_tag`.
 *
 * A wrangler config lists tagged migrations instead, and {@link toMigrationSteps} converts one to
 * the other, as wrangler does. The API refuses a list with a "cannot unmarshal array" error.
 */
export interface MigrationSteps {
	old_tag?: string;
	new_tag: string;
	steps: Omit<Migration, 'tag' | 'old_tag' | 'new_tag'>[];
}

export interface ObservabilitySettings {
	enabled: boolean;
	head_sampling_rate?: number;
}

export interface AssetConfig {
	html_handling?: string;
	not_found_handling?: string;
	run_worker_first?: boolean | string[];
	_headers?: string;
	_redirects?: string;
}

export interface UploadMetadata {
	main_module?: string;
	body_part?: string;
	bindings?: Binding[];
	compatibility_date?: string;
	compatibility_flags?: string[];
	/** a wrangler-style tagged list, converted on upload, or the stepped object as the API takes it */
	migrations?: Migration[] | MigrationSteps;
	exports?: Record<string, DurableObjectExport>;
	placement?: { mode?: string };
	tags?: string[];
	tail_consumers?: { service: string; environment?: string; namespace?: string }[];
	logpush?: boolean;
	observability?: ObservabilitySettings;
	keep_bindings?: string[];
	keep_assets?: boolean;
	assets?: { jwt?: string; config?: AssetConfig };
	limits?: { cpu_ms?: number };
	usage_model?: string;
	annotations?: Record<string, string>;
}

export interface UploadInput {
	/** the modules, from any source */
	source: ModuleSet;
	/** the entry point, as the module set names it. Defaults to the only `.js` when there is one */
	main?: string;
	/** override the inferred type for a path, for a bundle that ships CommonJS or a raw blob */
	types?: Record<string, ModuleType>;
	metadata?: Omit<UploadMetadata, 'main_module'>;
	/**
	 * The migration tag the deployed Worker already carries, for an update. Migrations up to it are
	 * left out, and the rest go with `old_tag` set. Leave it unset for a first upload.
	 */
	appliedMigrationTag?: string;
}

/** the name a Worker upload uses for the metadata part */
export const METADATA_PART = 'metadata';

/**
 * Picks the entry point when the caller did not name one.
 *
 * Only guesses when the answer is unambiguous. A bundle with three JavaScript modules and no stated
 * main is a caller mistake, and picking one of the three would produce a Worker that deploys and does
 * the wrong thing, which is worse than a refusal.
 */
export function inferMain(source: ModuleSet): string {
	const names = [...source.keys()];
	for (const candidate of ['index.js', 'index.mjs', 'worker.js', 'main.js']) {
		if (source.has(candidate)) return candidate;
	}
	const scripts = names.filter(
		(n) => moduleTypeOf(n) === 'esm' || moduleTypeOf(n) === 'commonjs'
	);
	if (scripts.length === 1) return scripts[0] as string;
	if (scripts.length === 0) {
		throw new UsageError('the module set holds no JavaScript, so there is no entry point');
	}
	throw new UsageError(
		`the module set holds ${scripts.length} scripts and none is named index.js, so name the entry point explicitly`
	);
}

/**
 * Refuses a metadata document Cloudflare would reject, before spending a request on it.
 *
 * `exports` and `migrations` are mutually exclusive: a configuration carrying both is rejected at
 * validation, and once a Worker has deployed with `exports` it has to keep using it.
 */
export function assertMetadata(metadata: UploadMetadata): void {
	if (metadata.exports !== undefined && metadata.migrations !== undefined) {
		throw new UsageError(
			'exports and migrations cannot both be set; a Worker deployed with exports keeps using exports'
		);
	}
	if (metadata.bindings !== undefined) assertBindings(metadata.bindings);
	if (
		metadata.compatibility_date !== undefined &&
		!/^\d{4}-\d{2}-\d{2}$/.test(metadata.compatibility_date)
	) {
		throw new UsageError(
			`compatibility_date must be YYYY-MM-DD, not ${metadata.compatibility_date}`
		);
	}
	for (const [name, declared] of Object.entries(metadata.exports ?? {})) {
		if (declared.state === 'renamed' && declared.renamed_to === undefined) {
			throw new UsageError(`the renamed export ${name} needs renamed_to`);
		}
		if (declared.state === 'transferred' && declared.transferred_to === undefined) {
			throw new UsageError(`the transferred export ${name} needs transferred_to`);
		}
		if (declared.state === 'expecting-transfer' && declared.transfer_from === undefined) {
			throw new UsageError(`the export ${name} expecting a transfer needs transfer_from`);
		}
	}
}

/**
 * Converts a tagged migration list to the one object the upload API takes.
 *
 * Returns undefined when there is nothing to apply: an empty list, or a Worker that already carries
 * the last tag. A tag the list does not hold (it may have been pruned) applies every step.
 */
export function toMigrationSteps(
	migrations: readonly Migration[],
	appliedTag?: string
): MigrationSteps | undefined {
	const last = migrations[migrations.length - 1];
	if (last === undefined) return undefined;
	for (const migration of migrations) {
		if (migration.tag === undefined) throw new UsageError('every migration needs a tag');
	}
	const newTag = last.tag as string;
	const applied =
		appliedTag === undefined ? -1 : migrations.findIndex((m) => m.tag === appliedTag);
	if (applied === migrations.length - 1) return undefined;
	const steps = migrations
		.slice(applied + 1)
		.map(({ tag: _tag, old_tag: _old, new_tag: _new, ...step }) => step);
	return appliedTag === undefined
		? { new_tag: newTag, steps }
		: { old_tag: appliedTag, new_tag: newTag, steps };
}

/** whether this upload changes a Durable Object's lifecycle, which several endpoints refuse */
export function carriesLifecycleChange(metadata: UploadMetadata): boolean {
	const { migrations } = metadata;
	if (Array.isArray(migrations) ? migrations.length > 0 : (migrations?.steps.length ?? 0) > 0) {
		return true;
	}
	return Object.values(metadata.exports ?? {}).some(
		(declared) => declared.state !== undefined && declared.state !== 'created'
	);
}

export interface BuiltUpload {
	body: FormData;
	metadata: UploadMetadata;
}

/**
 * Builds the upload body.
 *
 * Module parts are named by their path so `import './util.js'` resolves the way the bundle expects;
 * renaming them here is how a working bundle becomes one that cannot find its own imports.
 */
export function buildUpload(input: UploadInput): BuiltUpload {
	if (input.source.size === 0) {
		throw new UsageError('the module set is empty, so there is nothing to upload');
	}

	const main = normalisePath(input.main ?? inferMain(input.source));
	if (!input.source.has(main)) {
		throw new UsageError(`the entry point ${main} is not in the module set`);
	}

	const given: UploadMetadata = { ...input.metadata, main_module: main };
	assertMetadata(given);
	const { migrations, ...rest } = given;
	const wire = Array.isArray(migrations)
		? toMigrationSteps(migrations, input.appliedMigrationTag)
		: migrations;
	const metadata: UploadMetadata = wire === undefined ? rest : { ...rest, migrations: wire };

	const body = new FormData();
	body.set(METADATA_PART, JSON.stringify(metadata));

	for (const [path, bytes] of input.source) {
		const type = input.types?.[path] ?? moduleTypeOf(path);
		body.set(path, new Blob([asBinary(bytes)], { type: MODULE_CONTENT_TYPE[type] }), path);
	}

	return { body, metadata };
}
