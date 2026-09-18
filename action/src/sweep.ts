/**
 * Deciding which previews to remove.
 *
 * **Inactivity is measured from the pull request, not from the Worker.** A request count needs one
 * observability query per Worker and spends budget; `updated_at` arrives for every open pull request
 * in a single call. `wf:ttl` is the backstop: it is written at creation and honoured regardless of
 * pull request state, so a preview cannot outlive it even if the sweep never runs.
 */

export interface PreviewRecord {
	worker: string;
	pr: number | null;
	/** milliseconds since the epoch, after which this is removable whatever the PR says */
	ttlAtMs: number | null;
}

export interface PullRequestState {
	number: number;
	state: 'open' | 'closed';
	updatedAtMs: number;
}

export type SweepReasonKind = 'closed' | 'stale' | 'expired' | 'orphaned';

export interface SweepDecision {
	worker: string;
	remove: boolean;
	reason: SweepReasonKind | 'keep';
	detail: string;
}

export interface SweepInput {
	previews: readonly PreviewRecord[];
	pulls: readonly PullRequestState[];
	staleAfterMs: number;
	nowMs: number;
}

/**
 * Which previews to remove and why.
 *
 * Pure, so the rule is testable without a network. Every removal carries a reason, because a sweep
 * that reports a count is one nobody can audit.
 */
export function planSweep(input: SweepInput): SweepDecision[] {
	const byNumber = new Map(input.pulls.map((pull) => [pull.number, pull]));

	return input.previews.map((preview) => {
		if (preview.ttlAtMs !== null && preview.ttlAtMs <= input.nowMs) {
			return {
				worker: preview.worker,
				remove: true,
				reason: 'expired',
				detail: `its ttl passed at ${new Date(preview.ttlAtMs).toISOString()}`
			};
		}

		if (preview.pr === null) {
			return {
				worker: preview.worker,
				remove: false,
				reason: 'keep',
				detail: 'not tagged with a pull request, so this sweep does not own it'
			};
		}

		const pull = byNumber.get(preview.pr);
		if (pull === undefined) {
			// a preview naming a pull request nobody can find is orphaned, but removing it on a
			// partial listing would delete live previews, so it is reported rather than swept
			return {
				worker: preview.worker,
				remove: false,
				reason: 'orphaned',
				detail: `names pull request #${preview.pr}, which was not in the listing`
			};
		}

		if (pull.state === 'closed') {
			return {
				worker: preview.worker,
				remove: true,
				reason: 'closed',
				detail: `pull request #${pull.number} is closed`
			};
		}

		const idleMs = input.nowMs - pull.updatedAtMs;
		if (idleMs > input.staleAfterMs) {
			return {
				worker: preview.worker,
				remove: true,
				reason: 'stale',
				detail: `pull request #${pull.number} has not moved in ${Math.floor(idleMs / 86_400_000)} days`
			};
		}

		return {
			worker: preview.worker,
			remove: false,
			reason: 'keep',
			detail: `pull request #${pull.number} is open and active`
		};
	});
}

export function removals(decisions: readonly SweepDecision[]): SweepDecision[] {
	return decisions.filter((decision) => decision.remove);
}
