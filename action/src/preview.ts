/**
 * The preview lifecycle, as operations rather than as logging.
 *
 * Always a managed Worker. Cloudflare does not generate preview URLs for a Worker implementing a
 * Durable Object, and serves no logs for any preview URL, so the native path is unavailable for half
 * the cases and unobservable for the rest. A named Worker has its own subdomain, its own logs and its
 * own Access policy.
 */

import type { ModuleSet } from '@drupflare/workforce';
import { Access, Routing, type Workforce } from '@drupflare/workforce';

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
	secrets?: Record<string, string>;
	vars?: Record<string, string>;
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

export async function deployPreview(input: DeployInput): Promise<DeployResult> {
	const worker = input.client.worker(input.name);

	const vars = Object.entries(input.vars ?? {}).map(([name, text]) => ({
		type: 'plain_text' as const,
		name,
		text
	}));

	const uploaded = await worker.upload({
		source: input.source,
		metadata: {
			compatibility_date: input.compatibilityDate ?? '2026-08-01',
			tags: previewTags(input.pr, input.ttlAtMs),
			...(vars.length === 0 ? {} : { bindings: vars })
		}
	});

	for (const [name, text] of Object.entries(input.secrets ?? {})) {
		await worker.secrets.put(name, text);
	}

	const routing = new Routing(input.client.plane.http, input.accountId);
	// exactly one URL: the subdomain on, and the per-version preview URLs off
	const subdomain = await routing.setSubdomain(input.name, { enabled: true, previews: false });
	const host = subdomain.enabled ? await routing.hostname(input.name) : null;

	let accessAppId: string | null = null;
	if (input.access) {
		const summary = await worker.get();
		const workerId = summary?.id;
		if (workerId !== null && workerId !== undefined) {
			const app = await new Access(input.client.plane.http, input.accountId).ensure({
				name: `preview ${input.name}`,
				workerId,
				...(input.accessPolicyId === null ? {} : { policies: [input.accessPolicyId] })
			});
			accessAppId = app.id;
		}
	}

	return {
		name: input.name,
		url: host === null ? null : `https://${host}`,
		versionId: uploaded.versionId,
		accessAppId
	};
}

export interface DestroyInput {
	client: Workforce;
	accountId: string;
	name: string;
}

/** Removes the preview and the Access application that covered it. */
export async function destroyPreview(input: DestroyInput): Promise<{ removed: boolean }> {
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
