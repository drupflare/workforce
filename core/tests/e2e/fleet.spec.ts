/**
 * Many workers at once, against a plane that reports a real budget.
 *
 * The local plane emits `Ratelimit` headers it computes from its own request count, so the governor
 * meets values it did not fabricate and a fan-out is measured rather than described.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	cloudflare,
	fleetMeter,
	fromFiles,
	mapFleet,
	workforce,
	type Workforce
} from '../../src/index.js';
import { LOCAL_ACCOUNT, startLocalPlane, type LocalPlane } from './server/index.js';

const source = fromFiles({ 'index.js': 'export default { fetch: () => new Response("ok") };' });
const FLEET = Array.from({ length: 20 }, (_, i) => `wf-e2e-fleet-${i.toString().padStart(2, '0')}`);

describe('a fleet of twenty', () => {
	let local: LocalPlane;
	let client: Workforce;

	beforeAll(async () => {
		local = await startLocalPlane({ quota: 400, windowSeconds: 60 });
		client = workforce({
			plane: cloudflare({
				accountId: LOCAL_ACCOUNT,
				token: 'local',
				baseUrl: local.baseUrl
			})
		});
	});

	afterAll(async () => {
		await local.close();
	});

	it('provisions every one of them', async () => {
		const result = await mapFleet(
			FLEET,
			async (name) => {
				await client.worker(name).upload({
					source,
					metadata: { compatibility_date: '2026-08-01' }
				});
			},
			{ concurrency: 4 }
		);
		expect(result.ok).toBe(true);
		expect(result.succeeded.length).toBe(FLEET.length);
		expect(local.state.scripts.size).toBe(FLEET.length);
	});

	it('lists the whole fleet back', async () => {
		const names = (await client.list()).map((w) => w.name);
		for (const name of FLEET) expect(names).toContain(name);
	});

	it('tracks the budget from the plane own headers rather than from a guess', async () => {
		const snapshot = client.plane.http.budget.snapshot();
		expect(snapshot.quota).toBe(400);
		// the plane has answered many requests by now, so the governor should have counted them down
		expect(snapshot.remaining).toBeLessThan(400);
	});

	it('patches the whole fleet under a constrained concurrency', async () => {
		const result = await mapFleet(
			FLEET,
			async (name) => {
				await client.worker(name).setTags([`wf:env=dev`]);
			},
			{ concurrency: 2 }
		);
		expect(result.ok).toBe(true);
		const settings = await client.worker(FLEET[0] as string).settings();
		expect(settings.tags).toContain('wf:env=dev');
	});

	it('sums per-worker readings into a fleet total, naming who did not report', () => {
		const readings = FLEET.map((worker, at) => ({
			worker,
			values: { rowsToday: at === 0 ? null : 10 }
		}));
		const meter = fleetMeter(readings);
		expect(meter.totals.rowsToday).toBe((FLEET.length - 1) * 10);
		expect(meter.missing.rowsToday).toEqual([FLEET[0]]);
		expect(meter.workers).toBe(FLEET.length);
	});

	it('deletes the whole fleet, leaving the account as it was found', async () => {
		const result = await mapFleet(FLEET, async (name) => client.worker(name).delete(), {
			concurrency: 4
		});
		expect(result.ok).toBe(true);
		expect(local.state.scripts.size).toBe(0);
	});
});
