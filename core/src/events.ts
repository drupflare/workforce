import type { Fetcher } from './client/fetch.js';

/**
 * What happened, for whoever is counting.
 *
 * **This library emits; it never decides what an event costs.** A CLI running on a customer's laptop
 * self-reporting its own usage is not a meter anyone should bill from, and the boundary that makes
 * that unnecessary is the credential: on a plane whose credential the control plane owns it observes
 * by executing, and on a plane the customer owns the tier is flat so an exact count is not
 * load-bearing for revenue.
 *
 * A sink is optional. With none configured every operation behaves identically and the events go
 * nowhere.
 */

export type EventName =
	| 'worker.created'
	| 'worker.updated'
	| 'worker.deleted'
	| 'version.created'
	| 'version.deployed'
	| 'version.rolled-back'
	| 'version.reverted'
	| 'assets.synced'
	| 'secret.set'
	| 'secret.deleted'
	| 'resource.created'
	| 'resource.deleted'
	| 'conversion.started'
	| 'conversion.completed'
	| 'fleet.applied';

export interface WorkforceEvent {
	name: EventName;
	at: number;
	/** which plane it happened on, so a consumer can tell managed from self-managed */
	plane: string;
	target: string;
	/** the worker, namespace or resource this is about */
	subject: string | null;
	data: Record<string, unknown>;
}

export interface EventSink {
	emit(event: WorkforceEvent): Promise<void>;
}

/** discards everything, which is what a caller with no sink gets */
export const nullSink: EventSink = {
	async emit() {}
};

/** keeps events in memory, for a test or a dry run */
export function memorySink(): EventSink & { events: WorkforceEvent[] } {
	const events: WorkforceEvent[] = [];
	return {
		events,
		async emit(event) {
			events.push(event);
		}
	};
}

/**
 * Posts events to an endpoint.
 *
 * Failures are swallowed on purpose: telemetry that can fail an operation is worse than telemetry
 * that is occasionally missing, and the consumer that cares about exactness is the one executing.
 */
export function httpSink(
	url: string,
	options: { token?: string; fetch?: Fetcher } = {}
): EventSink {
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	return {
		async emit(event) {
			try {
				await fetcher(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(options.token === undefined
							? {}
							: { authorization: `Bearer ${options.token}` })
					},
					body: JSON.stringify(event)
				});
			} catch {
				// see the docblock: a sink must not be able to fail the operation it describes
			}
		}
	};
}

/** several sinks as one, so a caller can keep events locally and send them on */
export function fanOut(...sinks: EventSink[]): EventSink {
	return {
		async emit(event) {
			await Promise.all(sinks.map((sink) => sink.emit(event)));
		}
	};
}

export interface EmitInput {
	name: EventName;
	plane: string;
	target: string;
	subject?: string | null;
	data?: Record<string, unknown>;
	now?: () => number;
}

export async function emit(sink: EventSink, input: EmitInput): Promise<void> {
	await sink.emit({
		name: input.name,
		at: (input.now ?? Date.now)(),
		plane: input.plane,
		target: input.target,
		subject: input.subject ?? null,
		data: input.data ?? {}
	});
}
