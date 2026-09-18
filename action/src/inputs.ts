/**
 * Reading the Action's inputs.
 *
 * Names match `cloudflare/wrangler-action` wherever the meaning is the same, so a workflow converts
 * by changing the `uses:` line. Both spellings are accepted, because `apiToken` and `api-token` are
 * each somebody's habit and neither is wrong.
 */

export type Mode = 'deploy' | 'destroy' | 'sweep';

export interface Inputs {
	apiToken: string;
	accountId: string;
	command: string[];
	preCommands: string[];
	postCommands: string[];
	workingDirectory: string | null;
	quiet: boolean;
	environment: string | null;
	secrets: string[];
	vars: string[];
	packageManager: string | null;
	gitHubToken: string | null;

	mode: Mode;
	worker: string | null;
	config: string | null;
	directory: string;
	nameTemplate: string;
	ttlMs: number;
	staleAfterMs: number;
	access: boolean;
	accessPolicyId: string | null;
	cleanup: boolean;
	comment: boolean;
}

export type Reader = (name: string) => string;

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000
};

/** `7d`, `36h`, `90m`. Refuses anything else rather than silently meaning zero. */
export function parseDuration(value: string, what: string): number {
	const matched = DURATION.exec(value.trim());
	if (matched === null) {
		throw new Error(
			`${what} is "${value}", which is not a duration; use a number and a unit such as 7d, 36h or 90m`
		);
	}
	return Number(matched[1]) * (UNIT_MS[(matched[2] as string).toLowerCase()] as number);
}

/** newline-separated, blank lines and comments dropped */
export function parseLines(value: string): string[] {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

export function parseBoolean(value: string, fallback: boolean): boolean {
	const trimmed = value.trim().toLowerCase();
	if (trimmed === '') return fallback;
	return trimmed === 'true' || trimmed === '1' || trimmed === 'yes';
}

function either(read: Reader, camel: string, kebab: string): string {
	const first = read(camel);
	return first === '' ? read(kebab) : first;
}

export function parseMode(value: string): Mode {
	const trimmed = value.trim().toLowerCase();
	if (trimmed === '' || trimmed === 'deploy') return 'deploy';
	if (trimmed === 'destroy') return 'destroy';
	if (trimmed === 'sweep') return 'sweep';
	throw new Error(`mode is "${value}"; it has to be deploy, destroy or sweep`);
}

export function readInputs(read: Reader): Inputs {
	const ttl = either(read, 'ttl', 'ttl');
	const stale = either(read, 'staleAfter', 'stale-after');
	return {
		apiToken: either(read, 'apiToken', 'api-token'),
		accountId: either(read, 'accountId', 'account-id'),
		command: parseLines(read('command')),
		preCommands: parseLines(either(read, 'preCommands', 'pre-commands')),
		postCommands: parseLines(either(read, 'postCommands', 'post-commands')),
		workingDirectory: either(read, 'workingDirectory', 'working-directory') || null,
		quiet: parseBoolean(read('quiet'), false),
		environment: read('environment') || null,
		secrets: parseLines(read('secrets')),
		vars: parseLines(read('vars')),
		packageManager: either(read, 'packageManager', 'package-manager') || null,
		gitHubToken: either(read, 'gitHubToken', 'github-token') || null,

		mode: parseMode(read('mode')),
		worker: read('worker') || null,
		config: read('config') || null,
		directory: read('directory') || 'dist',
		nameTemplate: either(read, 'nameTemplate', 'name-template') || '{worker}-pr-{pr}',
		ttlMs: parseDuration(ttl === '' ? '7d' : ttl, 'ttl'),
		staleAfterMs: parseDuration(stale === '' ? '14d' : stale, 'staleAfter'),
		access: parseBoolean(read('access'), false),
		accessPolicyId: either(read, 'accessPolicyId', 'access-policy-id') || null,
		cleanup: parseBoolean(read('cleanup'), true),
		comment: parseBoolean(read('comment'), true)
	};
}

/** `{worker}-pr-{pr}` with the parts filled in, then trimmed to what a Worker name may be */
export function previewName(template: string, worker: string, pr: number): string {
	const filled = template
		.replace(/\{worker\}/g, worker)
		.replace(/\{pr\}/g, String(pr))
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return filled.slice(0, 63).replace(/-$/, '');
}
