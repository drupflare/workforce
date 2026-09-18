/**
 * Findings, rungs, and the fleet-wide denominator a single worker structurally cannot see.
 *
 * **The vocabulary is deliberately the same as `drupflare/worker`'s**, which already has a good
 * version of this: `src/ops/repair.ts` defines the rung ladder and the rule that a DIFFERENT failure
 * code resets the strike count, "because two unrelated faults are not evidence of one durable
 * condition"; `src/ops/supervisor.ts` defines the severities and the flat-primitives observation, and
 * its governing principle is that "a repair path must not depend on the subsystem it repairs". Two
 * halves of one ladder should speak one language, so a finding a worker writes is a finding this can
 * read without translation. Nothing here imports anything drupflare-shaped.
 *
 * What a fleet layer adds is the half a single worker cannot do: quotas are account-wide and every
 * per-worker instrument reads only itself, so N workers can saturate an account while each reads as
 * healthy.
 */

export const SEVERITY = {
	info: 0,
	warn: 1,
	error: 2,
	critical: 3
} as const;

export type Severity = keyof typeof SEVERITY;

/** the repair ladder, in order; a rung is only ever climbed one at a time */
export const RUNGS = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;

export type Rung = (typeof RUNGS)[number];

/** consecutive same-code failures before quarantine; below this the lower rungs own the problem */
export const QUARANTINE_STRIKES = 3;

export interface Finding {
	/** stable dotted identifier; a breaker keys on this rather than on the message */
	code: string;
	severity: Severity;
	/** what it was about: a worker, a binding, a route */
	scope: string;
	context: string;
}

export interface RepairState {
	rung: Rung;
	/** the failure code the strikes belong to; a different code resets the count */
	code: string | null;
	strikes: number;
	quarantinedAtMs: number | null;
}

export const CLEAN_STATE: RepairState = {
	rung: 'observe',
	code: null,
	strikes: 0,
	quarantinedAtMs: null
};

/**
 * Folds one outcome into the state.
 *
 * A different failure code resets the strike count: two unrelated faults are not evidence of one
 * durable condition, and summing them quarantines something for having two bad days.
 */
export function recordOutcome(
	state: RepairState,
	outcome: { ok: boolean; code?: string | null },
	nowMs: number
): RepairState {
	if (outcome.ok) {
		// a clean pass clears the strikes and does NOT un-quarantine: leaving quarantine is a
		// separate explicit act, because one good result says nothing about what caused the fault
		return { ...state, code: null, strikes: 0 };
	}
	const code = outcome.code ?? 'unknown';
	const strikes = state.code === code ? state.strikes + 1 : 1;
	const next: RepairState = { ...state, code, strikes };
	if (strikes >= QUARANTINE_STRIKES && state.rung !== 'quarantine' && state.rung !== 'rollback') {
		return { ...next, rung: 'quarantine', quarantinedAtMs: nowMs };
	}
	return next;
}

export interface MeterReading {
	/** the worker this came from */
	worker: string;
	/** whatever the worker reports; unknown fields are carried rather than dropped */
	values: Record<string, number | null>;
}

export interface FleetMeter {
	/** summed across every worker that reported a number */
	totals: Record<string, number>;
	/** workers that reported nothing for a given key, so a sum is never mistaken for complete */
	missing: Record<string, string[]>;
	workers: number;
	reporting: number;
}

/**
 * Sums per-worker readings into the account-wide denominator.
 *
 * A missing field is recorded rather than counted as zero. The whole reason this exists is that a
 * per-worker reading cannot see the account, and a sum that quietly treats silence as zero
 * reintroduces exactly the blindness it was built to remove.
 */
export function fleetMeter(readings: readonly MeterReading[]): FleetMeter {
	const totals: Record<string, number> = {};
	const missing: Record<string, string[]> = {};
	const keys = new Set(readings.flatMap((r) => Object.keys(r.values)));

	for (const key of keys) {
		totals[key] = 0;
		missing[key] = [];
		for (const reading of readings) {
			const value = reading.values[key];
			if (typeof value === 'number') totals[key] += value;
			else missing[key].push(reading.worker);
		}
	}

	return {
		totals,
		missing,
		workers: readings.length,
		reporting: readings.filter((r) => Object.values(r.values).some((v) => v !== null)).length
	};
}

export interface ShareInput {
	/** the account-wide allowance for this meter */
	allowance: number;
	/** what the fleet has already spent */
	spent: number;
	/** how many workers share it */
	workers: number;
}

export interface Share {
	/** the fraction of the allowance already gone */
	used: number;
	/** what is left, spread evenly */
	perWorker: number;
	remaining: number;
}

/**
 * What one worker's fair share of a shared allowance is.
 *
 * This is the number a per-worker governor cannot compute for itself, and the reason a fleet layer
 * has to supply it rather than each worker assuming it owns the whole account.
 */
export function fairShare(input: ShareInput): Share {
	const remaining = Math.max(0, input.allowance - input.spent);
	return {
		used: input.allowance === 0 ? 1 : Math.min(1, input.spent / input.allowance),
		perWorker: input.workers === 0 ? remaining : remaining / input.workers,
		remaining
	};
}

export interface HealthRollup {
	workers: number;
	findings: Finding[];
	worst: Severity | null;
	byCode: Record<string, number>;
	quarantined: string[];
}

/** Folds many workers' findings into one verdict, which is what a dashboard shows. */
export function rollup(
	entries: readonly { worker: string; findings: Finding[]; state?: RepairState }[]
): HealthRollup {
	const findings = entries.flatMap((e) => e.findings);
	const byCode: Record<string, number> = {};
	for (const finding of findings) byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;

	let worst: Severity | null = null;
	for (const finding of findings) {
		if (worst === null || SEVERITY[finding.severity] > SEVERITY[worst])
			worst = finding.severity;
	}

	return {
		workers: entries.length,
		findings,
		worst,
		byCode,
		quarantined: entries
			.filter((e) => e.state?.rung === 'quarantine' || e.state?.rung === 'rollback')
			.map((e) => e.worker)
	};
}
