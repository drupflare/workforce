/**
 * A declaration for `@drupflare/untarl`.
 *
 * untarl ships raw TypeScript rather than a build, so without this every consumer typechecks its
 * source under the consumer's own `types` configuration. It is written against
 * `@cloudflare/workers-types` alone and does not compile when node's stream types are also present,
 * which this package needs for its node subpath and its test lane. Declaring the surface pins what we
 * use and takes its source out of our compilation.
 *
 * Mirrors untarl 0.1.0. Re-check it when that version moves.
 */
declare module '@drupflare/untarl' {
	export type TarEntryType = 'file' | 'directory';

	export interface TarEntry {
		name: string;
		size: number;
		type: TarEntryType;
		mode: number;
		bytes: Uint8Array;
	}

	export class TarParseError extends Error {
		offset: number | undefined;
	}

	export class TarPathError extends Error {}

	export function parseTar(bytes: Uint8Array): TarEntry[];
	export function untarGzip(stream: ReadableStream<Uint8Array>): Promise<TarEntry[]>;
	export function tarEntryTree(entries: TarEntry[], strip?: number): Map<string, Uint8Array>;
}
