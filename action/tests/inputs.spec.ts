import { describe, expect, it } from 'vitest';
import {
	parseBoolean,
	parseDuration,
	parseLines,
	parseMode,
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
