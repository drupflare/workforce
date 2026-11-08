import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	branchLabel,
	parseBoolean,
	parseDuration,
	parseLines,
	parseMode,
	previewHostname,
	previewName,
	readInputs
} from '../src/inputs.js';

const reader = (values: Record<string, string>) => (name: string) => values[name] ?? '';

describe('parseDuration', () => {
	it('reads the units a workflow would write', () => {
		expect(parseDuration('7d', 'ttl')).toBe(7 * 86_400_000);
		expect(parseDuration('36h', 'ttl')).toBe(36 * 3_600_000);
		expect(parseDuration('90m', 'ttl')).toBe(90 * 60_000);
		expect(parseDuration('2w', 'ttl')).toBe(2 * 604_800_000);
	});

	it('refuses something that is not a duration rather than meaning zero', () => {
		expect(() => parseDuration('soon', 'ttl')).toThrow(/not a duration/);
		expect(() => parseDuration('7', 'ttl')).toThrow(/not a duration/);
	});
});

describe('parseLines', () => {
	it('drops blanks and comments', () => {
		expect(parseLines('A\n\n# a note\n B ')).toEqual(['A', 'B']);
	});
});

describe('parseBoolean', () => {
	it('takes the spellings a workflow uses and falls back when empty', () => {
		expect(parseBoolean('true', false)).toBe(true);
		expect(parseBoolean('1', false)).toBe(true);
		expect(parseBoolean('false', true)).toBe(false);
		expect(parseBoolean('', true)).toBe(true);
	});
});

describe('parseMode', () => {
	it('defaults to deploy and refuses anything it does not know', () => {
		expect(parseMode('')).toBe('deploy');
		expect(parseMode('SWEEP')).toBe('sweep');
		expect(() => parseMode('explode')).toThrow(/deploy, destroy or sweep/);
	});
});

describe('readInputs', () => {
	it('accepts wrangler-action camelCase spellings', () => {
		const inputs = readInputs(
			reader({ apiToken: 'tok', accountId: 'acct', preCommands: 'echo one' })
		);
		expect(inputs.apiToken).toBe('tok');
		expect(inputs.accountId).toBe('acct');
		expect(inputs.preCommands).toEqual(['echo one']);
	});

	it('accepts the kebab-case spellings too, because both are somebody habit', () => {
		const inputs = readInputs(reader({ 'api-token': 'tok', 'account-id': 'acct' }));
		expect(inputs.apiToken).toBe('tok');
		expect(inputs.accountId).toBe('acct');
	});

	it('defaults the preview knobs', () => {
		const inputs = readInputs(reader({}));
		expect(inputs.mode).toBe('deploy');
		expect(inputs.nameTemplate).toBe('{worker}-pr-{pr}');
		expect(inputs.ttlMs).toBe(7 * 86_400_000);
		expect(inputs.staleAfterMs).toBe(14 * 86_400_000);
		expect(inputs.cleanup).toBe(true);
		expect(inputs.comment).toBe(true);
		expect(inputs.access).toBe(false);
	});
});

describe('previewName', () => {
	it('fills the template', () => {
		expect(previewName('{worker}-pr-{pr}', 'my-api', 412)).toBe('my-api-pr-412');
	});

	it('produces something a Worker may actually be called', () => {
		expect(previewName('{worker}_PR_{pr}', 'My API', 7)).toBe('my-api-pr-7');
	});

	it('stays inside the length a Worker name allows', () => {
		const long = previewName('{worker}-pr-{pr}', 'x'.repeat(200), 1);
		expect(long.length).toBeLessThanOrEqual(63);
		expect(long.endsWith('-')).toBe(false);
	});
});

describe('branchLabel', () => {
	it('lowercases and turns each run of other characters into one dash', () => {
		expect(branchLabel('Feat/Add_Thing.v2')).toBe('feat-add-thing-v2');
		expect(branchLabel('feat//double---dash')).toBe('feat-double-dash');
	});

	it('trims dashes from both ends', () => {
		expect(branchLabel('/-leading-and-trailing-/')).toBe('leading-and-trailing');
	});

	it('turns non-ASCII letters into dashes rather than keeping them', () => {
		expect(branchLabel('feature/ünïcode')).toBe('feature-n-code');
	});

	it('refuses a branch with nothing a label can use', () => {
		expect(() => branchLabel('///')).toThrow(/no characters a DNS label can use/);
	});

	it('leaves a label of exactly 63 characters alone', () => {
		const exact = 'a'.repeat(63);
		expect(branchLabel(exact)).toBe(exact);
	});

	it('truncates an overflowing label and appends six hex characters of the original branch hash', () => {
		const branch = 'x'.repeat(80);
		const label = branchLabel(branch);
		const hash = createHash('sha256').update(branch).digest('hex').slice(0, 6);
		expect(label).toBe(`${'x'.repeat(56)}-${hash}`);
		expect(label.length).toBe(63);
	});

	it('gives two long branches that differ only late different labels', () => {
		const a = branchLabel(`feature/${'long-'.repeat(12)}alpha`);
		const b = branchLabel(`feature/${'long-'.repeat(12)}beta`);
		expect(a).not.toBe(b);
		expect(a.length).toBeLessThanOrEqual(63);
		expect(b.length).toBeLessThanOrEqual(63);
	});

	it('is deterministic', () => {
		expect(branchLabel('feature/x'.repeat(20))).toBe(branchLabel('feature/x'.repeat(20)));
	});

	it('refuses a budget too small to hold the branch and its hash', () => {
		expect(() => branchLabel('feature-branch', 7)).toThrow(/no room for the branch/);
	});
});

describe('previewHostname', () => {
	const values = { branch: 'feat/x', pr: 7, worker: 'dashboard' };

	it('fills the branch into the template', () => {
		expect(previewHostname('{branch}-staging-app.drupflare.com', values, 'drupflare.com')).toBe(
			'feat-x-staging-app.drupflare.com'
		);
	});

	it('fills the pr and worker tokens too', () => {
		expect(
			previewHostname(
				'pr-{pr}-{worker}.drupflare.com',
				{ ...values, branch: 'main' },
				'drupflare.com'
			)
		).toBe('pr-7-dashboard.drupflare.com');
	});

	it('keeps the finished label within 63 characters by truncating the branch part', () => {
		const host = previewHostname(
			'{branch}-staging-app.drupflare.com',
			{ ...values, branch: 'x'.repeat(80) },
			'drupflare.com'
		);
		const first = host.split('.')[0] as string;
		expect(first.length).toBe(63);
		expect(first.endsWith('-staging-app')).toBe(true);
	});

	it('refuses a hostname outside the zone', () => {
		expect(() => previewHostname('{branch}.example.net', values, 'drupflare.com')).toThrow(
			/is not inside drupflare.com/
		);
	});

	it('refuses a label the DNS would reject', () => {
		expect(() =>
			previewHostname('{branch}_x.drupflare.com', { ...values, branch: 'a' }, 'drupflare.com')
		).toThrow(/not a valid DNS label/);
	});
});

describe('readInputs for previews on a custom hostname', () => {
	it('reads the hostname template, zone and access emails', () => {
		const inputs = readInputs(
			reader({
				hostnameTemplate: '{branch}-staging-app.drupflare.com',
				zone: 'drupflare.com',
				accessEmails: 'a@example.com\n# a note\nb@example.com'
			})
		);
		expect(inputs.hostnameTemplate).toBe('{branch}-staging-app.drupflare.com');
		expect(inputs.zone).toBe('drupflare.com');
		expect(inputs.accessEmails).toEqual(['a@example.com', 'b@example.com']);
	});

	it('accepts the kebab spellings of the two multi-word inputs', () => {
		const inputs = readInputs(
			reader({
				'hostname-template': '{branch}.drupflare.com',
				'access-emails': 'a@example.com'
			})
		);
		expect(inputs.hostnameTemplate).toBe('{branch}.drupflare.com');
		expect(inputs.accessEmails).toEqual(['a@example.com']);
	});

	it('defaults to workers.dev with no emails, which is what today does', () => {
		const inputs = readInputs(reader({}));
		expect(inputs.hostnameTemplate).toBeNull();
		expect(inputs.zone).toBeNull();
		expect(inputs.accessEmails).toEqual([]);
	});
});
