/**
 * Logs and analytics.
 *
 * **Prefer the query API over tail, and the reason is measured rather than stylistic.**
 * `drupflare/worker` compared the two in 2026-08, recorded at
 * `drangler/src/cloudflare/tail.ts:26-32`: `wrangler tail --format json` returned 12 stateless events
 * at 0-1 ms and ZERO durableObject events for the same invocations the Observability API reported as
 * 15 durableObject events with a 6,509 ms max. The expensive half of the trace was simply absent and
 * nothing marked it dropped. So `tail()` carries the same instrument-failure guard: a capture with
 * stateless events and no durable-object event is reported as a broken instrument rather than as a
 * reading.
 *
 * This is also the half that fills a `worker-requests`-shaped meter. A request answered at the edge
 * never reaches the object that would count it, so that number comes from analytics or from nowhere.
 */

import type { HttpClient } from './client/fetch.js';

export interface TelemetryQuery {
	/** milliseconds since the epoch */
	from: number;
	to: number;
	limit?: number;
	/** the dataset to read; Workers logs live in `cloudflare-workers` */
	dataset?: string;
	filters?: { key: string; operation: string; value: string | number | boolean }[];
	/** what to group by, for a count rather than a list */
	groupBy?: string[];
}

export interface TelemetryEvent {
	timestamp: number | null;
	scriptName: string | null;
	outcome: string | null;
	executionModel: string | null;
	cpuTimeMs: number | null;
	wallTimeMs: number | null;
	message: string | null;
	raw: Record<string, unknown>;
}

function eventOf(row: Record<string, unknown>): TelemetryEvent {
	const source = (row.$metadata ?? row) as Record<string, unknown>;
	const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
	const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
	return {
		timestamp: num(source.timestamp ?? row.timestamp),
		scriptName: str(row.scriptName ?? row.$workers?.valueOf()),
		outcome: str(row.outcome),
		executionModel: str(row.executionModel),
		cpuTimeMs: num(row.cpuTime),
		wallTimeMs: num(row.wallTime),
		message: str(row.message ?? source.message),
		raw: row
	};
}

export interface CpuSummary {
	n: number;
	median: number;
	min: number;
	max: number;
	/** max minus min, because the platform is bimodal and a bare median hides that */
	spread: number;
}

/** the n below which this project refuses an absolute, given a 400-600 ms bimodal platform */
export const MIN_SAMPLES = 3;

export interface CpuReport {
	events: number;
	byModel: Record<string, CpuSummary>;
	/**
	 * The capture holds stateless events and no durable-object event at all.
	 *
	 * Measured: `wrangler tail` has returned exactly this shape while the Observability API reported
	 * durable-object events for the same invocations. A capture like it is an instrument failure, and
	 * quoting a CPU figure from one is the failure mode this flag exists to prevent.
	 */
	instrumentFailure: boolean;
	usable: boolean;
	notes: string[];
}

function summarise(values: number[]): CpuSummary {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	const median =
		sorted.length === 0
			? 0
			: sorted.length % 2 === 1
				? (sorted[mid] as number)
				: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	const min = sorted[0] ?? 0;
	const max = sorted[sorted.length - 1] ?? 0;
	return { n: sorted.length, median, min, max, spread: max - min };
}

/** Summarises CPU per execution model, and says whether the capture may be quoted at all. */
export function summariseCpu(events: readonly TelemetryEvent[]): CpuReport {
	const groups = new Map<string, number[]>();
	for (const event of events) {
		if (event.cpuTimeMs === null) continue;
		const model = event.executionModel ?? 'unknown';
		const bucket = groups.get(model) ?? [];
		bucket.push(event.cpuTimeMs);
		groups.set(model, bucket);
	}

	const byModel: Record<string, CpuSummary> = {};
	for (const [model, values] of groups) byModel[model] = summarise(values);

	const stateless = byModel.stateless?.n ?? 0;
	const durable = byModel.durableObject?.n ?? 0;
	const instrumentFailure = stateless > 0 && durable === 0;

	const notes: string[] = [];
	if (instrumentFailure) {
		notes.push(
			'this capture has stateless events and no durableObject event; tail has been measured omitting them silently, so read it as an instrument failure rather than a reading'
		);
	}
	if (durable > 0 && durable < MIN_SAMPLES) {
		notes.push(
			`n=${durable} durableObject events; the platform is bimodal by several hundred milliseconds, so an absolute is not supportable at this n`
		);
	}
	for (const [model, summary] of Object.entries(byModel)) {
		if (summary.spread > 400) {
			notes.push(`${model} spans ${summary.spread} ms between min and max; quote the spread`);
		}
	}
	if (events.length === 0) notes.push('the capture is empty, which is not evidence of anything');

	return {
		events: events.length,
		byModel,
		instrumentFailure,
		usable: !instrumentFailure && durable + stateless > 0,
		notes
	};
}

export interface TailSession {
	id: string;
	url: string;
	expiresAt: string | null;
}

/** The observability surface for one account. */
export class Observability {
	constructor(
		private readonly http: HttpClient,
		private readonly accountId: string
	) {}

	private get base(): string {
		return `/accounts/${this.accountId}/workers/observability`;
	}

	/** the instrument to prefer; `tail` is the one with the measured blind spot */
	async query(query: TelemetryQuery): Promise<TelemetryEvent[]> {
		const result = await this.http.request<{ events?: { events?: Record<string, unknown>[] } }>(
			`${this.base}/telemetry/query`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					queryId: 'workforce',
					timeframe: { from: query.from, to: query.to },
					limit: query.limit ?? 100,
					dry: false,
					parameters: {
						datasets: [query.dataset ?? 'cloudflare-workers'],
						filters: query.filters ?? [],
						groupBys: (query.groupBy ?? []).map((key) => ({
							type: 'string',
							value: key
						}))
					}
				})
			}
		);
		return (result.events?.events ?? []).map(eventOf);
	}

	/** the distinct values a key takes, for building a filter without guessing */
	async values(key: string, from: number, to: number): Promise<string[]> {
		const result = await this.http.request<{ values?: { value?: string }[] }>(
			`${this.base}/telemetry/values`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					key,
					type: 'string',
					datasets: ['cloudflare-workers'],
					timeframe: { from, to },
					limit: 100
				})
			}
		);
		return (result.values ?? []).map((v) => String(v.value ?? ''));
	}

	/**
	 * How many requests a Worker served.
	 *
	 * This is the number a per-object meter structurally cannot produce: a request answered at the
	 * edge never reaches the object that would count it.
	 */
	async requestCount(scriptName: string, from: number, to: number): Promise<number> {
		const events = await this.query({
			from,
			to,
			limit: 10_000,
			filters: [{ key: 'scriptName', operation: 'eq', value: scriptName }]
		});
		return events.length;
	}
}

/** Starts a tail session. Prefer {@link Observability.query}; see this module's note. */
export async function startTail(
	http: HttpClient,
	accountId: string,
	scriptName: string
): Promise<TailSession> {
	const result = await http.request<{ id?: string; url?: string; expires_at?: string }>(
		`/accounts/${accountId}/workers/scripts/${scriptName}/tails`,
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
	);
	return {
		id: String(result.id ?? ''),
		url: String(result.url ?? ''),
		expiresAt: result.expires_at ?? null
	};
}

export async function stopTail(
	http: HttpClient,
	accountId: string,
	scriptName: string,
	id: string
): Promise<void> {
	await http.send(`/accounts/${accountId}/workers/scripts/${scriptName}/tails/${id}`, {
		method: 'DELETE'
	});
}
