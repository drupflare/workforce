/**
 * Paging, over both shapes this API uses.
 *
 * Some collections page by `page`/`per_page` and report `total_pages`; others hand back an opaque
 * cursor. A caller should not have to know which, so both become the same async iterable.
 */

import type { HttpClient, RequestOptions, ResultInfo } from './fetch.js';

export interface PageOptions extends RequestOptions {
	/** items per request; the API caps this per endpoint and silently clamps */
	perPage?: number;
	/** stop after this many items, so a caller can peek without walking a fleet */
	limit?: number;
}

/**
 * Unwraps the two shapes this API uses for a collection.
 *
 * Some endpoints answer with a bare array and others wrap it in `{ items }`. Measured against the
 * real API: `GET /workers/scripts` returns an array and `GET /workers/scripts/:s/versions` returns
 * `{ items: [...] }`. A pager that assumes one shape throws "result is not iterable" on the other,
 * which is what the integration lane caught and the local plane did not.
 */
export function itemsOf<T>(result: unknown): T[] {
	if (Array.isArray(result)) return result as T[];
	if (result !== null && typeof result === 'object') {
		const wrapped = (result as { items?: unknown }).items;
		if (Array.isArray(wrapped)) return wrapped as T[];
	}
	return [];
}

/** whether `result_info` says another page exists */
export function hasMore(info: ResultInfo, seen: number): boolean {
	if (typeof info.cursor === 'string' && info.cursor !== '') return true;
	if (typeof info.total_pages === 'number' && typeof info.page === 'number') {
		return info.page < info.total_pages;
	}
	if (typeof info.total_count === 'number') return seen < info.total_count;
	return false;
}

/**
 * Walks a paginated collection.
 *
 * Stops on an empty page even when the envelope claims more, because a server that reports
 * `total_count` from a stale index otherwise turns a listing into a loop.
 */
export async function* paginate<T>(
	client: HttpClient,
	path: string,
	options: PageOptions = {}
): AsyncGenerator<T, void, undefined> {
	const { perPage, limit, query, ...rest } = options;
	let page = 1;
	let cursor: string | undefined;
	let seen = 0;

	for (;;) {
		const { result: raw, info } = await client.requestPage<unknown>(path, {
			...rest,
			query: {
				...query,
				page: cursor === undefined ? page : undefined,
				per_page: perPage,
				cursor
			}
		});

		const result = itemsOf<T>(raw);
		if (result.length === 0) return;

		for (const item of result) {
			yield item;
			seen += 1;
			if (limit !== undefined && seen >= limit) return;
		}

		if (!hasMore(info, seen)) return;

		if (typeof info.cursor === 'string' && info.cursor !== '') {
			cursor = info.cursor;
		} else {
			page += 1;
		}
	}
}

/** the same walk, collected. Use it when the collection is known to be small */
export async function collect<T>(
	client: HttpClient,
	path: string,
	options: PageOptions = {}
): Promise<T[]> {
	const out: T[] = [];
	for await (const item of paginate<T>(client, path, options)) out.push(item);
	return out;
}
