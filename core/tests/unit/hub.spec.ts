import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/client/errors.js';
import { hub } from '../../src/client/hub.js';
import { cloudflare } from '../../src/plane/cloudflare.js';

describe('Hub', () => {
	it('holds several planes by name', () => {
		const h = hub();
		h.add('ours', cloudflare({ accountId: 'a', token: 'token-a' }));
		h.add('acme', cloudflare({ accountId: 'b', token: 'token-b' }));
		expect(
			h
				.list()
				.map((e) => e.name)
				.sort()
		).toEqual(['acme', 'ours']);
		expect(h.has('ours')).toBe(true);
	});

	it('refuses two planes under one name rather than replacing one silently', () => {
		const h = hub();
		h.add('ours', cloudflare({ accountId: 'a', token: 't' }));
		expect(() => h.add('ours', cloudflare({ accountId: 'c', token: 'u' }))).toThrow(UsageError);
	});

	it('names what it holds when asked for something it does not', () => {
		const h = hub();
		h.add('ours', cloudflare({ accountId: 'a', token: 't' }));
		expect(() => h.get('missing')).toThrow(/it holds ours/);
	});

	it('shares one budget across two accounts reached with one token', () => {
		const h = hub();
		const one = cloudflare({ accountId: 'one', token: 'shared' });
		const two = cloudflare({ accountId: 'two', token: 'shared' });
		h.add('one', one).add('two', two);
		expect(h.budgetFor(one.credentialKey)).toBe(h.budgetFor(two.credentialKey));
	});

	it('keeps separate budgets for separate credentials', () => {
		const h = hub();
		const a = cloudflare({ accountId: 'one', token: 'token-a' });
		const b = cloudflare({ accountId: 'two', token: 'token-b' });
		expect(h.budgetFor(a.credentialKey)).not.toBe(h.budgetFor(b.credentialKey));
	});

	it('groups planes by the credential they actually spend', () => {
		const h = hub();
		h.add('one', cloudflare({ accountId: 'one', token: 'shared' }));
		h.add('two', cloudflare({ accountId: 'two', token: 'shared' }));
		h.add('other', cloudflare({ accountId: 'three', token: 'different' }));
		const grouped = h.byCredential();
		expect(grouped.size).toBe(2);
		expect(
			grouped
				.get('shared')
				?.map((e) => e.name)
				.sort()
		).toEqual(['one', 'two']);
	});
});
