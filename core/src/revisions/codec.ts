/**
 * Compression, as a registry rather than a constant.
 *
 * strata carries several codecs behind a registry with a measurement beside them, so the choice is
 * measured rather than assumed. The same applies here with a narrower set: `CompressionStream` is what
 * a Worker runtime supplies, and the web standard defines it for gzip and deflate. Brotli and zstd are
 * not part of that standard, so they are absent until something measures them being available.
 *
 * `none` is the default, which makes the first implementation plain framing. Turning gzip on later is
 * a store-level change and not a format break, because every frame records the codec that wrote it.
 */

import { UsageError } from '../client/errors.js';

export type CodecName = 'none' | 'gzip' | 'deflate';

export interface Codec {
	readonly name: CodecName;
	encode(bytes: Uint8Array): Promise<Uint8Array>;
	decode(bytes: Uint8Array): Promise<Uint8Array>;
}

async function through(bytes: Uint8Array, stream: ReadableWritablePair): Promise<Uint8Array> {
	const source = new Response(bytes.slice().buffer as ArrayBuffer).body;
	if (source === null) throw new UsageError('could not stream the payload');
	return new Uint8Array(await new Response(source.pipeThrough(stream as never)).arrayBuffer());
}

export const noneCodec: Codec = {
	name: 'none',
	async encode(bytes) {
		return bytes;
	},
	async decode(bytes) {
		return bytes;
	}
};

function streamCodec(name: 'gzip' | 'deflate'): Codec {
	return {
		name,
		async encode(bytes) {
			return through(bytes, new CompressionStream(name));
		},
		async decode(bytes) {
			return through(bytes, new DecompressionStream(name));
		}
	};
}

export const gzipCodec: Codec = streamCodec('gzip');
export const deflateCodec: Codec = streamCodec('deflate');

const REGISTRY: Record<CodecName, Codec> = {
	none: noneCodec,
	gzip: gzipCodec,
	deflate: deflateCodec
};

export function codecFor(name: CodecName): Codec {
	const codec = REGISTRY[name];
	if (codec === undefined) throw new UsageError(`no codec named ${name}`);
	return codec;
}

export interface CodecMeasurement {
	name: CodecName;
	inputBytes: number;
	outputBytes: number;
	ratio: number;
}

/**
 * Measures each codec against real bytes.
 *
 * Exported so a caller picks from a reading of their own payload rather than from a table in a
 * README. Compression ratio is a property of the data, and a Worker bundle is not a corpus.
 */
export async function measureCodecs(
	bytes: Uint8Array,
	names: CodecName[] = ['none', 'gzip', 'deflate']
): Promise<CodecMeasurement[]> {
	const out: CodecMeasurement[] = [];
	for (const name of names) {
		const encoded = await codecFor(name).encode(bytes);
		out.push({
			name,
			inputBytes: bytes.byteLength,
			outputBytes: encoded.byteLength,
			ratio: bytes.byteLength === 0 ? 1 : encoded.byteLength / bytes.byteLength
		});
	}
	return out;
}
