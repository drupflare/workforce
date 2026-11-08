/**
 * The preview lifecycle, as operations rather than as logging.
 *
 * Always a managed Worker. Cloudflare does not generate preview URLs for a Worker implementing a
 * Durable Object, and serves no logs for any preview URL, so the native path is unavailable for half
 * the cases and unobservable for the rest. A named Worker has its own subdomain, its own logs and its
 * own Access policy.
 */

import type { ModuleSet } from '@drupflare/workforce';
import {
	Access,
	assertBindings,
	Routing,
	type Binding,
	type Workforce
} from '@drupflare/workforce';
import { fromDirectory } from '@drupflare/workforce/node';
import { dirname, resolve } from 'node:path';

export interface PreviewConfig {
	compatibilityDate: string | null;
	compatibilityFlags: string[];
	bindings: Binding[];
	/** the asset directory, resolved against the config file, and the binding it is served on */
	assets: { directory: string; binding: string } | null;
}

export interface DeployInput {
	client: Workforce;
	accountId: string;
	name: string;
	source: ModuleSet;
	compatibilityDate?: string;
	ttlAtMs: number;
	pr: number;
	access: boolean;
	accessPolicyId: string | null;
	accessEmails?: string[];
	secrets?: Record<string, string>;
	vars?: Record<string, string>;
	config?: PreviewConfig | null;
	assets?: { binding: string; tree: ModuleSet } | null;
	hostname?: { hostname: string; zone: string } | null;
}

export interface DeployResult {
	name: string;
	url: string | null;
	versionId: string | null;
	accessAppId: string | null;
}

/** `wf:pr` and `wf:ttl` are what a later sweep reads; nothing else needs to be queryable */
export function previewTags(pr: number, ttlAtMs: number): string[] {
	return [`wf:pr=${pr}`, `wf:ttl=${ttlAtMs}`];
}

export function readPreviewTags(tags: readonly string[]): {
	pr: number | null;
	ttlAtMs: number | null;
} {
	let pr: number | null = null;
	let ttlAtMs: number | null = null;
	for (const tag of tags) {
		const [key, value] = tag.split('=', 2);
		if (key === 'wf:pr' && value !== undefined) {
			const parsed = Number(value);
			pr = Number.isFinite(parsed) ? parsed : null;
		}
		if (key === 'wf:ttl' && value !== undefined) {
			const parsed = Number(value);
			ttlAtMs = Number.isFinite(parsed) ? parsed : null;
		}
	}
	return { pr, ttlAtMs };
}

/** keys a wrangler file may carry that a preview has no use for */
const IGNORED_KEYS = new Set([
	'$schema',
	'name',
	'main',
	'routes',
	'workers_dev',
	'preview_urls',
	'observability',
	'triggers',
	'secrets'
]);

// a list or object holding no entries has no binding to lose
function isEmpty(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value).every(isEmpty);
}

function objectOf(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${where} has to be an object`);
	}
	return value as Record<string, unknown>;
}

function listOf(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${where} has to be a list`);
	return value;
}

/** one entry of a binding list, with exactly these string fields and nothing else */
function entryOf(
	value: unknown,
	where: string,
	fields: readonly string[],
	harmless: readonly string[] = []
): Record<string, string> {
	const given = objectOf(value, where);
	for (const key of Object.keys(given)) {
		if (!fields.includes(key) && !harmless.includes(key)) {
			throw new Error(
				`${where} has ${key}, which a preview does not support; refusing rather than dropping it`
			);
		}
	}
	for (const field of fields) {
		if (typeof given[field] !== 'string') throw new Error(`${where} needs ${field}`);
	}
	return given as Record<string, string>;
}

function assetsOf(value: unknown, configPath: string): { directory: string; binding: string } {
	const given = objectOf(value, 'assets');
	for (const key of Object.keys(given)) {
		if (key !== 'directory' && key !== 'binding') {
			throw new Error(
				`assets has ${key}, which a preview does not support; refusing rather than dropping it`
			);
		}
	}
	if (typeof given.directory !== 'string') throw new Error('assets needs directory');
	if (given.binding !== undefined && typeof given.binding !== 'string') {
		throw new Error('assets.binding has to be a string');
	}
	return {
		directory: resolve(dirname(configPath), given.directory),
		binding: typeof given.binding === 'string' ? given.binding : 'ASSETS'
	};
}

/**
 * Translates a rendered wrangler JSON file into what a preview uploads.
 *
 * Strict in both directions: a top-level key or an entry field it does not know is refused by name,
 * because a preview that quietly lost a binding would deploy and fail at the first request that
 * needed it.
 */
export function translateConfig(text: string, configPath: string): PreviewConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath} is not JSON: ${reason}`);
	}
	const top = objectOf(raw, configPath);

	const config: PreviewConfig = {
		compatibilityDate: null,
		compatibilityFlags: [],
		bindings: [],
		assets: null
	};
	for (const [key, value] of Object.entries(top)) {
		if (IGNORED_KEYS.has(key)) continue;
		switch (key) {
			case 'compatibility_date':
				if (typeof value !== 'string')
					throw new Error('compatibility_date has to be a string');
				config.compatibilityDate = value;
				break;
			case 'compatibility_flags':
				config.compatibilityFlags = listOf(value, key).map((flag) => {
					if (typeof flag !== 'string')
						throw new Error('compatibility_flags has to be strings');
					return flag;
				});
				break;
			case 'd1_databases':
				for (const item of listOf(value, key)) {
					// these only configure wrangler's own migrations and naming
					const e = entryOf(
						item,
						key,
						['binding', 'database_id'],
						['database_name', 'migrations_dir', 'migrations_table']
					);
					config.bindings.push({
						type: 'd1',
						name: e.binding as string,
						id: e.database_id as string
					});
				}
				break;
			case 'kv_namespaces':
				for (const item of listOf(value, key)) {
					const e = entryOf(item, key, ['binding', 'id']);
					config.bindings.push({
						type: 'kv_namespace',
						name: e.binding as string,
						namespace_id: e.id as string
					});
				}
				break;
			case 'r2_buckets':
				for (const item of listOf(value, key)) {
					const e = entryOf(item, key, ['binding', 'bucket_name']);
					config.bindings.push({
						type: 'r2_bucket',
						name: e.binding as string,
						bucket_name: e.bucket_name as string
					});
				}
				break;
			case 'send_email':
				for (const item of listOf(value, key)) {
					const e = entryOf(item, key, ['name']);
					config.bindings.push({ type: 'send_email', name: e.name as string });
				}
				break;
			case 'vars':
				for (const [name, text] of Object.entries(objectOf(value, key))) {
					if (typeof text !== 'string') throw new Error(`vars.${name} must be a string`);
					config.bindings.push({ type: 'plain_text', name, text });
				}
				break;
			case 'assets':
				config.assets = assetsOf(value, configPath);
				break;
			default:
				if (isEmpty(value)) break;
				throw new Error(
					`${key} is not a key a preview supports; refusing rather than dropping its binding`
				);
		}
	}
	assertBindings(config.bindings);
	return config;
}

/**
 * Worker modules from a build directory. Source maps and JSON sit beside the modules in a build, and
 * the upload should not carry them. A predicate on the path also sees directories, so this names the
 * extensions to leave out rather than the ones to keep.
 */
export function readModules(directory: string): Promise<ModuleSet> {
	return fromDirectory(directory, {
		ignore: (path) => path.endsWith('.json') || path.endsWith('.map')
	});
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function zoneIdOf(client: Workforce, zone: string): Promise<string> {
	let zones: { id?: string; name?: string }[];
	try {
		zones = await client.raw.request<{ id?: string; name?: string }[]>('/zones', {
			query: { name: zone }
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`could not read zone ${zone} (${reason}); the token needs Zone Read on it`);
	}
	const id = zones.find((candidate) => candidate.name === zone)?.id;
	if (id === undefined || id === '') {
		throw new Error(
			`no zone named ${zone} is visible to this token; it needs Zone Read on ${zone}`
		);
	}
	return id;
}

export async function deployPreview(input: DeployInput): Promise<DeployResult> {
	const accessEmails = input.accessEmails ?? [];
	if (input.access && input.accessPolicyId === null && accessEmails.length === 0) {
		throw new Error(
			'access is on, but there is no accessPolicyId and no accessEmails, so the preview would be open; name one of them'
		);
	}
	const badEmail = accessEmails.find((email) => !EMAIL.test(email));
	if (badEmail !== undefined)
		throw new Error(`${badEmail} in accessEmails is not an email address`);

	const worker = input.client.worker(input.name);
	const zoneId = input.hostname ? await zoneIdOf(input.client, input.hostname.zone) : null;

	const bindings: Binding[] = [
		...(input.config?.bindings ?? []),
		...Object.entries(input.vars ?? {}).map(([name, text]): Binding => ({
			type: 'plain_text',
			name,
			text
		}))
	];
	if (input.assets) bindings.push({ type: 'assets', name: input.assets.binding });
	assertBindings(bindings);

	// the completion token goes into the script upload, so the assets are synced first
	const assetsToken = input.assets
		? (await worker.assets.sync(input.assets.tree)).completionToken
		: null;

	const flags = input.config?.compatibilityFlags ?? [];
	const uploaded = await worker.upload({
		source: input.source,
		metadata: {
			compatibility_date:
				input.config?.compatibilityDate ?? input.compatibilityDate ?? '2026-08-01',
			...(flags.length === 0 ? {} : { compatibility_flags: flags }),
			tags: previewTags(input.pr, input.ttlAtMs),
			...(bindings.length === 0 ? {} : { bindings }),
			...(assetsToken === null ? {} : { assets: { jwt: assetsToken } })
		}
	});

	for (const [name, text] of Object.entries(input.secrets ?? {})) {
		await worker.secrets.put(name, text);
	}

	// Access goes on before the Worker is reachable, so there is no window where it answers ungated
	let accessAppId: string | null = null;
	if (input.access) {
		const workerId = (await worker.get())?.id;
		if (workerId === null || workerId === undefined) {
			await worker.delete();
			throw new Error(
				`${input.name} has no id to attach Access to, so it was removed rather than left open`
			);
		}
		const access = new Access(input.client.plane.http, input.accountId);
		const existing = await access.forWorker(workerId);
		if (existing === null) {
			const policies = input.accessPolicyId === null ? [] : [input.accessPolicyId];
			if (accessEmails.length > 0) {
				const policy = await access.createPolicy({
					name: `preview ${input.name}`,
					emails: accessEmails
				});
				policies.push(policy.id);
			}
			accessAppId = (
				await access.create({ name: `preview ${input.name}`, workerId, policies })
			).id;
		} else {
			accessAppId = existing.id;
		}
	}

	const routing = new Routing(input.client.plane.http, input.accountId);
	let url: string | null;
	if (input.hostname && zoneId !== null) {
		await routing.attachDomain({
			hostname: input.hostname.hostname,
			zoneId,
			service: input.name
		});
		await routing.setSubdomain(input.name, { enabled: false });
		url = `https://${input.hostname.hostname}`;
	} else {
		// exactly one URL: the subdomain on, and the per-version preview URLs off
		const subdomain = await routing.setSubdomain(input.name, {
			enabled: true,
			previews: false
		});
		const host = subdomain.enabled ? await routing.hostname(input.name) : null;
		url = host === null ? null : `https://${host}`;
	}

	return {
		name: input.name,
		url,
		versionId: uploaded.versionId,
		accessAppId
	};
}

export interface DestroyInput {
	client: Workforce;
	accountId: string;
	name: string;
}

/** Removes the preview, the domains it was published on, and the Access application that covered it. */
export async function destroyPreview(input: DestroyInput): Promise<{ removed: boolean }> {
	const routing = new Routing(input.client.plane.http, input.accountId);
	for (const domain of await routing.domains()) {
		if (domain.service === input.name) await routing.detachDomain(domain.id);
	}

	const worker = input.client.worker(input.name);
	const summary = await worker.get();
	if (summary === null) return { removed: false };

	if (summary.id !== null) {
		const access = new Access(input.client.plane.http, input.accountId);
		const app = await access.forWorker(summary.id);
		if (app !== null) await access.delete(app.id);
	}

	await worker.delete();
	return { removed: true };
}

/** fills `{hostname}` in each var, so a Worker can be told the address it will be served on */
export function withHostname(
	vars: Record<string, string>,
	hostname: string | null
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, text] of Object.entries(vars)) {
		if (!text.includes('{hostname}')) {
			out[name] = text;
			continue;
		}
		if (hostname === null) {
			throw new Error(`${name} uses {hostname}, but no hostnameTemplate is set`);
		}
		out[name] = text.split('{hostname}').join(hostname);
	}
	return out;
}
