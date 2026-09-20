import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/client/budget.js';
import { HttpClient } from '../../src/client/fetch.js';
import { Routing } from '../../src/worker/routing.js';
import { envelope, stubFetch, type StubReply } from '../helpers/fetch.js';

function routing(replies: StubReply[]) {
	const { fetch, calls } = stubFetch(replies);
	const http = new HttpClient(() => ({ authorization: 'Bearer t' }), {
		fetch,
		budget: new Budget()
	});
	return { routing: new Routing(http, 'acct'), calls };
}

describe('Routing subdomain', () => {
	it('reads whether the hostname and the per-version previews are on', async () => {
		const { routing: r } = routing([
			{ body: envelope({ enabled: true, previews_enabled: false }) }
		]);
		expect(await r.subdomain('api')).toEqual({ enabled: true, previewsEnabled: false });
	});

	it('turns the hostname on and the per-version previews off in one call', async () => {
		const { routing: r, calls } = routing([
			{ body: envelope({ enabled: true, previews_enabled: false }) }
		]);
		await r.setSubdomain('api', { enabled: true, previews: false });
		const sent = JSON.parse(String(calls[0]?.body)) as Record<string, boolean>;
		expect(sent).toEqual({ enabled: true, previews_enabled: false });
	});

	it('leaves previews alone when the caller says nothing about them', async () => {
		const { routing: r, calls } = routing([{ body: envelope({ enabled: true }) }]);
		await r.setSubdomain('api', { enabled: true });
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ enabled: true });
	});

	describe('Routing hostname', () => {
		it('reads the account subdomain', async () => {
			const { routing: r, calls } = routing([{ body: envelope({ subdomain: 'gmitch215' }) }]);
			expect(await r.accountSubdomain()).toBe('gmitch215');
			expect(calls[0]?.url).toContain('/accounts/acct/workers/subdomain');
		});

		it('builds the hostname a subdomain-enabled Worker answers on', async () => {
			const { routing: r } = routing([{ body: envelope({ subdomain: 'gmitch215' }) }]);
			expect(await r.hostname('api-pr-7')).toBe('api-pr-7.gmitch215.workers.dev');
		});

		it('answers null when the account has no subdomain, rather than inventing a hostname', async () => {
			const { routing: r } = routing([{ body: envelope({}) }]);
			expect(await r.hostname('api')).toBeNull();
		});
	});
});

describe('Routing schedules', () => {
	it('reads and writes cron triggers', async () => {
		const { routing: r, calls } = routing([
			{ body: envelope({ schedules: [{ cron: '*/5 * * * *' }] }) }
		]);
		expect(await r.setSchedules('api', ['*/5 * * * *'])).toEqual([{ cron: '*/5 * * * *' }]);
		expect(JSON.parse(String(calls[0]?.body))).toEqual([{ cron: '*/5 * * * *' }]);
	});
});

describe('Routing routes and domains', () => {
	it('adds a zone route', async () => {
		const { routing: r, calls } = routing([{ body: envelope({ id: 'route-1' }) }]);
		const route = await r.addRoute('zone', 'example.com/*', 'api');
		expect(route).toEqual({ id: 'route-1', pattern: 'example.com/*', script: 'api' });
		expect(calls[0]?.url).toContain('/zones/zone/workers/routes');
	});

	it('attaches a custom domain', async () => {
		const { routing: r } = routing([{ body: envelope({ id: 'domain-1' }) }]);
		const domain = await r.attachDomain({
			hostname: 'api.example.com',
			zoneId: 'z',
			service: 'api'
		});
		expect(domain).toMatchObject({ id: 'domain-1', hostname: 'api.example.com' });
	});

	it('lists domains out of the row shape the API uses', async () => {
		const { routing: r } = routing([
			{ body: envelope([{ id: 'd', hostname: 'a.example', zone_id: 'z', service: 'api' }]) }
		]);
		expect((await r.domains())[0]).toEqual({
			id: 'd',
			hostname: 'a.example',
			zoneId: 'z',
			service: 'api',
			environment: 'production'
		});
	});
});
