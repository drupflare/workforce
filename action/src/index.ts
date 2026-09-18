/**
 * The Action entry point.
 *
 * Two ways in. `command` runs any workforce operation, with `preCommands` and `postCommands` around
 * it, which is the shape `cloudflare/wrangler-action` established. `mode` is the preview behaviour and
 * runs when no command is given.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { cloudflare, workforce, type Workforce } from '@drupflare/workforce';
import { fromDirectory } from '@drupflare/workforce/node';
import { previewName, readInputs, type Inputs } from './inputs.js';
import { deployPreview, destroyPreview, readPreviewTags } from './preview.js';
import { planSweep, removals, type PreviewRecord, type PullRequestState } from './sweep.js';

export interface RunContext {
	inputs: Inputs;
	pr: number | null;
	repo: { owner: string; repo: string };
	nowMs: number;
}

export function readContext(read: (name: string) => string, nowMs = Date.now()): RunContext {
	const inputs = readInputs(read);
	const payload = github.context.payload as {
		pull_request?: { number?: number };
		number?: number;
	};
	return {
		inputs,
		pr: payload.pull_request?.number ?? payload.number ?? null,
		repo: github.context.repo,
		nowMs
	};
}

/** the Worker this run acts on, or a named refusal saying what is missing */
export function targetName(context: RunContext): string {
	const worker = context.inputs.worker;
	if (worker === null || worker === '') {
		throw new Error('no `worker` input, so there is nothing to name a preview after');
	}
	if (context.pr === null) {
		throw new Error(
			'this run is not about a pull request, so there is no number to put in the preview name; run it on a pull_request event or pass a command instead'
		);
	}
	return previewName(context.inputs.nameTemplate, worker, context.pr);
}

function clientFor(inputs: Inputs): { client: Workforce; accountId: string } {
	if (inputs.apiToken === '' || inputs.accountId === '') {
		throw new Error('apiToken and accountId are both required');
	}
	return {
		accountId: inputs.accountId,
		client: workforce({
			plane: cloudflare({ accountId: inputs.accountId, token: inputs.apiToken })
		})
	};
}

/** named environment variables, resolved from this workflow `env` the way wrangler-action does */
export function collectFromEnv(
	names: readonly string[],
	env: Record<string, string | undefined>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of names) {
		const value = env[name];
		if (value === undefined) {
			throw new Error(`${name} was listed but is not in this workflow env`);
		}
		out[name] = value;
	}
	return out;
}

async function runDeploy(context: RunContext): Promise<void> {
	const name = targetName(context);
	const { client, accountId } = clientFor(context.inputs);
	const directory =
		context.inputs.workingDirectory === null
			? context.inputs.directory
			: `${context.inputs.workingDirectory}/${context.inputs.directory}`;

	const result = await deployPreview({
		client,
		accountId,
		name,
		source: await fromDirectory(directory),
		ttlAtMs: context.nowMs + context.inputs.ttlMs,
		pr: context.pr as number,
		access: context.inputs.access,
		accessPolicyId: context.inputs.accessPolicyId,
		secrets: collectFromEnv(context.inputs.secrets, process.env),
		vars: collectFromEnv(context.inputs.vars, process.env)
	});

	core.setOutput('worker-name', result.name);
	core.setOutput('version-id', result.versionId ?? '');
	if (result.url !== null) core.setOutput('deployment-url', result.url);
	core.info(`preview ${result.name} is up`);

	await comment(context, result.name, result.url);
}

async function runDestroy(context: RunContext): Promise<void> {
	if (!context.inputs.cleanup) {
		core.info('cleanup is off, so the preview is being left in place');
		return;
	}
	const name = targetName(context);
	const { client, accountId } = clientFor(context.inputs);
	const { removed } = await destroyPreview({ client, accountId, name });
	core.setOutput('worker-name', name);
	core.info(removed ? `removed ${name}` : `${name} was already gone`);
}

async function runSweep(context: RunContext): Promise<void> {
	const { client, accountId } = clientFor(context.inputs);
	const token = context.inputs.gitHubToken;
	if (token === null) throw new Error('sweep needs gitHubToken to read pull request state');

	const workers = await client.list();
	const previews: PreviewRecord[] = [];
	for (const worker of workers) {
		const summary = await worker.get();
		if (summary === null) continue;
		const { pr, ttlAtMs } = readPreviewTags(summary.tags);
		if (pr === null && ttlAtMs === null) continue;
		previews.push({ worker: summary.name, pr, ttlAtMs });
	}

	const octokit = github.getOctokit(token);
	const pulls = await octokit.paginate(octokit.rest.pulls.list, {
		...context.repo,
		state: 'all',
		per_page: 100
	});
	const state: PullRequestState[] = pulls.map((pull) => ({
		number: pull.number,
		state: pull.state === 'closed' ? 'closed' : 'open',
		updatedAtMs: Date.parse(pull.updated_at)
	}));

	const decisions = planSweep({
		previews,
		pulls: state,
		staleAfterMs: context.inputs.staleAfterMs,
		nowMs: context.nowMs
	});

	let swept = 0;
	for (const decision of removals(decisions)) {
		core.info(`removing ${decision.worker}: ${decision.detail}`);
		await destroyPreview({ client, accountId, name: decision.worker });
		swept += 1;
	}
	for (const kept of decisions.filter((d) => !d.remove)) {
		core.info(`keeping ${kept.worker}: ${kept.detail}`);
	}
	core.setOutput('swept', String(swept));
}

async function comment(context: RunContext, name: string, url: string | null): Promise<void> {
	if (!context.inputs.comment || context.inputs.gitHubToken === null || context.pr === null)
		return;
	const body = [
		`### Preview: \`${name}\``,
		'',
		url === null ? 'Deployed. The URL is on the Worker subdomain.' : `<${url}>`,
		'',
		`_Removed when this pull request closes, or after ${Math.round(context.inputs.ttlMs / 86_400_000)} days._`
	].join('\n');

	const octokit = github.getOctokit(context.inputs.gitHubToken);
	await octokit.rest.issues.createComment({
		...context.repo,
		issue_number: context.pr,
		body
	});
}

export async function run(): Promise<void> {
	try {
		const context = readContext((name) => core.getInput(name));

		if (context.inputs.command.length > 0) {
			// the command surface shells out to the CLI, which lives in drangler; until that ships
			// this refuses rather than silently doing nothing
			throw new Error(
				'the `command` input needs the workforce CLI, which is not published yet; use `mode` for now'
			);
		}

		switch (context.inputs.mode) {
			case 'deploy':
				await runDeploy(context);
				return;
			case 'destroy':
				await runDestroy(context);
				return;
			case 'sweep':
				await runSweep(context);
				return;
		}
	} catch (error) {
		core.setFailed(error instanceof Error ? error.message : String(error));
	}
}

export { planSweep, previewName, readInputs, removals };
export type { Inputs, PreviewRecord, PullRequestState };

if (process.env.WORKFORCE_ACTION_TEST !== '1') {
	void run();
}
