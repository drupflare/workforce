/**
 * Fixed-size framing, and the digest each frame is addressed by.
 *
 * A Worker bundle is one large minified file that changes slightly every deploy, which is the shape
 * whole-file addressing is worst at: a one-line edit stores the whole bundle again. `@earth-app/strata`
 * solved the same problem for a different payload by framing at a fixed size and addressing each
 * frame, so an edit stores the frames it touched and dedup works inside a file as well as across
 * them. This is that, at the same 16 KiB.
 */

import { asBinary } from '../source.js';

/** strata's frame size, and the reason to match it is that the tradeoff is the same one */
export const FRAME_BYTES = 16 * 1024;

export interface Frame {
	hash: string;
	bytes: Uint8Array;
}

/** SHA-256 in full, unlike the asset manifest's truncated digest: this one addresses stored data */
export async function hashFrame(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asBinary(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Splits a payload into fixed-size frames. The last frame is short rather than padded. */
export async function frame(bytes: Uint8Array, size = FRAME_BYTES): Promise<Frame[]> {
	const frames: Frame[] = [];
	for (let at = 0; at < bytes.byteLength; at += size) {
		const slice = bytes.subarray(at, Math.min(at + size, bytes.byteLength));
		frames.push({ hash: await hashFrame(slice), bytes: slice });
	}
	return frames;
}

/** Puts a payload back together from its frames, in order. */
export function unframe(frames: readonly Uint8Array[]): Uint8Array {
	const total = frames.reduce((n, f) => n + f.byteLength, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of frames) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

/** how much of a frame list is already held, which is what addressing them buys */
export function dedupRatio(frames: readonly Frame[], held: ReadonlySet<string>): number {
	if (frames.length === 0) return 1;
	const reused = frames.filter((f) => held.has(f.hash)).length;
	return reused / frames.length;
}
