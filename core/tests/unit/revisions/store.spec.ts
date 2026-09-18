import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/client/errors.js';
import { codecFor, measureCodecs } from '../../../src/revisions/codec.js';
import { planRetention, prune, reachableFrames } from '../../../src/revisions/compact.js';
import {
	dedupRatio,
	frame,
	FRAME_BYTES,
	hashFrame,
	unframe
} from '../../../src/revisions/frame.js';
import { isForeignVersion, revisionIdOf, RevisionStore } from '../../../src/revisions/store.js';
import { summariseVerification, verifyAll, verifyRevision } from '../../../src/revisions/verify.js';
import { fromFiles, toUtf8 } from '../../../src/source.js';
import { memoryStore } from '../../../src/store/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** a payload big enough to span several frames, so framing is exercised rather than assumed */
function bigPayload(marker: string, size = FRAME_BYTES * 3 + 100): Uint8Array {
	const out = new Uint8Array(size);
	for (let at = 0; at < size; at += 1) out[at] = (at * 7) % 251;
	out.set(bytes(marker), 0);
	return out;
}

describe('frame', () => {
	it('splits at the frame size and leaves the last one short', async () => {
		const framed = await frame(new Uint8Array(FRAME_BYTES + 10));
		expect(framed.length).toBe(2);
		expect(framed[0]?.bytes.byteLength).toBe(FRAME_BYTES);
		expect(framed[1]?.bytes.byteLength).toBe(10);
	});

	it('round-trips through unframe', async () => {
		const original = bigPayload('hello');
		const framed = await frame(original);
		expect(unframe(framed.map((f) => f.bytes))).toEqual(original);
	});

	it('gives identical frames identical hashes, which is what makes dedup work', async () => {
		const a = await hashFrame(bytes('same'));
		const b = await hashFrame(bytes('same'));
		expect(a).toBe(b);
		expect(a).not.toBe(await hashFrame(bytes('different')));
	});

	it('reports how much of a frame list is already held', async () => {
		const framed = await frame(bigPayload('x'));
		const held = new Set(framed.slice(0, 2).map((f) => f.hash));
		expect(dedupRatio(framed, held)).toBeCloseTo(2 / framed.length);
	});
});

describe('codecs', () => {
	it('round-trips through every codec', async () => {
		for (const name of ['none', 'gzip', 'deflate'] as const) {
			const codec = codecFor(name);
			const encoded = await codec.encode(bytes('round trip me'));
			expect(toUtf8(await codec.decode(encoded))).toBe('round trip me');
		}
	});

	it('refuses a codec it does not have rather than falling back silently', () => {
		expect(() => codecFor('brotli' as never)).toThrow(UsageError);
	});

	it('measures each codec against the caller own bytes', async () => {
		const compressible = bytes('a'.repeat(4000));
		const measured = await measureCodecs(compressible);
		const none = measured.find((m) => m.name === 'none');
		const gzip = measured.find((m) => m.name === 'gzip');
		expect(none?.ratio).toBe(1);
		// a property rather than a threshold: gzip on repetitive input is smaller than not compressing
		expect(gzip?.outputBytes).toBeLessThan(none?.outputBytes as number);
	});
});

describe('RevisionStore', () => {
	it('writes a revision and reads the same modules back', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const modules = fromFiles({ 'index.js': 'export default 1', 'big.bin': bigPayload('b') });
		const { revision } = await revisions.write('api', modules);
		const read = await revisions.read('api', revision.id);
		expect(toUtf8(read.get('index.js') as Uint8Array)).toBe('export default 1');
		expect(read.get('big.bin')).toEqual(modules.get('big.bin'));
	});

	it('gives the same file set the same id whatever order it was walked in', async () => {
		const forwards = fromFiles({ 'a.js': '1', 'b.js': '2' });
		const backwards = new Map([...forwards.entries()].reverse());
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const first = await revisions.write('api', forwards);
		const second = await revisions.write('api', backwards);
		expect(second.revision.id).toBe(first.revision.id);
	});

	it('writes only the frames it does not already hold', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const first = await revisions.write('api', fromFiles({ 'big.bin': bigPayload('same') }));
		expect(first.wrote).toBeGreaterThan(1);

		const second = await revisions.write('api', fromFiles({ 'big.bin': bigPayload('same') }));
		expect(second.wrote).toBe(0);
		expect(second.reused).toBe(first.wrote);
	});

	it('stores only the changed frames when one file is edited', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const original = bigPayload('first');
		await revisions.write('api', fromFiles({ 'big.bin': original }));

		// change one byte in the first frame; every later frame is untouched and should be reused
		const edited = original.slice();
		edited[5] = (edited[5] as number) ^ 0xff;
		const second = await revisions.write('api', fromFiles({ 'big.bin': edited }));
		expect(second.wrote).toBe(1);
		expect(second.reused).toBeGreaterThan(1);
	});

	it('compresses stored frames when a codec is chosen, and still reads them back', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const modules = fromFiles({ 'a.txt': 'x'.repeat(5000) });
		const { revision } = await revisions.write('api', modules, { codec: 'gzip' });
		expect(revision.codec).toBe('gzip');
		expect(toUtf8((await revisions.read('api', revision.id)).get('a.txt') as Uint8Array)).toBe(
			'x'.repeat(5000)
		);
	});

	it('lists newest first and finds a revision by its plane version id', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		let clock = 1000;
		await revisions.write('api', fromFiles({ 'a.js': '1' }), {
			versionId: 'v1',
			now: () => clock
		});
		clock += 1000;
		await revisions.write('api', fromFiles({ 'a.js': '2' }), {
			versionId: 'v2',
			now: () => clock
		});
		const listed = await revisions.list('api');
		expect(listed[0]?.versionId).toBe('v2');
		expect((await revisions.byVersion('api', 'v1'))?.versionId).toBe('v1');
	});

	it('refuses to rebuild when a frame is gone, rather than returning half a Worker', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		const { revision } = await revisions.write(
			'api',
			fromFiles({ 'big.bin': bigPayload('x') })
		);
		await store.frames.delete(revision.files[0]?.frames[1] as string);
		await expect(revisions.read('api', revision.id)).rejects.toThrow(/no longer holds it/);
	});

	it('refuses to read a revision that does not exist', async () => {
		await expect(new RevisionStore(memoryStore()).read('api', 'nope')).rejects.toBeInstanceOf(
			UsageError
		);
	});
});

describe('revisionIdOf', () => {
	it('is stable and content dependent', async () => {
		const files = [{ path: 'a.js', frames: ['h1'], bytes: 2 }];
		expect(await revisionIdOf(files)).toBe(await revisionIdOf(files));
		expect(await revisionIdOf(files)).not.toBe(
			await revisionIdOf([{ path: 'a.js', frames: ['h2'], bytes: 2 }])
		);
	});
});

describe('isForeignVersion', () => {
	it('reads a version with no stored revision as foreign', () => {
		expect(isForeignVersion(null, 'etag')).toBe(true);
	});

	it('reads a matching etag as ours and a differing one as foreign', async () => {
		const store = memoryStore();
		const { revision } = await new RevisionStore(store).write(
			'api',
			fromFiles({ 'a.js': '1' }),
			{
				etag: 'abc'
			}
		);
		expect(isForeignVersion(revision, 'abc')).toBe(false);
		expect(isForeignVersion(revision, 'different')).toBe(true);
	});
});

describe('compaction', () => {
	it('keeps the newest and drops the rest', () => {
		const revisions = [1, 2, 3, 4].map((n) => ({
			id: `r${n}`,
			createdAtMs: n,
			files: []
		})) as never[];
		const { kept, dropped } = planRetention(revisions, 2);
		expect(kept.map((r) => r.id)).toEqual(['r4', 'r3']);
		expect(dropped.map((r) => r.id)).toEqual(['r2', 'r1']);
	});

	it('frees only the frames no surviving revision still names', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		let clock = 0;
		const shared = bigPayload('shared');
		for (const marker of ['one', 'two', 'three']) {
			clock += 1000;
			await revisions.write(
				'api',
				fromFiles({ 'shared.bin': shared, 'changing.txt': marker }),
				{ now: () => clock }
			);
		}

		const receipt = await prune(store, 'api', { retain: 1 });
		expect(receipt.dropped.length).toBe(2);
		// the shared payload survives because the kept revision still names its frames
		const kept = await revisions.list('api');
		const still = reachableFrames(kept);
		for (const hash of still) expect(await store.frames.get(hash)).not.toBeNull();
	});

	it('reports what it would do without touching anything', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		let clock = 0;
		for (const marker of ['a', 'b']) {
			clock += 1000;
			await revisions.write('api', fromFiles({ 'x.txt': marker }), { now: () => clock });
		}
		const receipt = await prune(store, 'api', { retain: 1, dryRun: true });
		expect(receipt.dropped.length).toBe(1);
		expect((await revisions.list('api')).length).toBe(2);
	});
});

describe('verification', () => {
	it('passes a revision that can still be rebuilt', async () => {
		const store = memoryStore();
		const { revision } = await new RevisionStore(store).write(
			'api',
			fromFiles({ 'a.js': 'content' })
		);
		expect((await verifyRevision(store, 'api', revision.id)).ok).toBe(true);
	});

	it('names the missing frame rather than reporting a vague failure', async () => {
		const store = memoryStore();
		const { revision } = await new RevisionStore(store).write(
			'api',
			fromFiles({ 'big.bin': bigPayload('x') })
		);
		const gone = revision.files[0]?.frames[0] as string;
		await store.frames.delete(gone);
		const result = await verifyRevision(store, 'api', revision.id);
		expect(result.ok).toBe(false);
		expect(result.missingFrames).toContain(gone);
	});

	it('reports a revision that does not exist as not ok', async () => {
		expect((await verifyRevision(memoryStore(), 'api', 'nope')).ok).toBe(false);
	});

	it('summarises a whole drill', async () => {
		const store = memoryStore();
		const revisions = new RevisionStore(store);
		let clock = 0;
		for (const marker of ['a', 'b']) {
			clock += 1000;
			await revisions.write('api', fromFiles({ 'x.txt': marker }), { now: () => clock });
		}
		const summary = summariseVerification(await verifyAll(store, 'api'));
		expect(summary.checked).toBe(2);
		expect(summary.ok).toBe(2);
		expect(summary.failed).toEqual([]);
	});
});
