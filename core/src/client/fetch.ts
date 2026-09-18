/**
 * The HTTP seam.
 *
 * Every call takes an injected {@link Fetcher} rather than reaching for a global, which is the only
 * reason the unit lane is hermetic, and `baseUrl` is what lets the same client drive a local plane.
 */

import { Budget, readRetryAfter } from './budget.js';
import { ApiError, AuthError, LimitError, NotFoundError, TransportError } from './errors.js';

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * The HTTP function this library calls.
 *
 * An explicit signature rather than `typeof fetch`, because that type is not the same under
 * @cloudflare/workers-types as it is under @types/node and a library that runs on both cannot mean
 * two things by it.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** the envelope this API wraps almost everything in */
export interface ApiEnvelope<T> {
	success?: boolean;
	errors?: { code?: number; message?: string }[];
	messages?: { code?: number; message?: string }[];
	result?: T;
	result_info?: ResultInfo;
}

export interface ResultInfo {
	page?: number;
	per_page?: number;
	count?: number;
	total_count?: number;
	total_pages?: number;
	cursor?: string;
}

export interface ClientOptions {
	fetch?: Fetcher;
	baseUrl?: string;
	budget?: Budget;
	/** how many times a retryable failure is retried before it is raised */
	retries?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** extra headers on every request, for a caller that has to identify itself */
	headers?: Record<string, string>;
}

export interface RequestOptions {
	method?: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: BodyInit | null;
	headers?: Record<string, string>;
	/** skip the envelope and hand back the raw response, for content and asset endpoints */
	raw?: boolean;
	signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** `{a: 1, b: undefined}` to `?a=1`, because an undefined filter is not the string "undefined" */
export function buildQuery(query: RequestOptions['query']): string {
	if (query === undefined) return '';
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue;
		params.set(key, String(value));
	}
	const encoded = params.toString();
	return encoded === '' ? '' : `?${encoded}`;
}

function detailsOf(body: ApiEnvelope<unknown>): { code: number | null; message: string }[] {
	return (body.errors ?? []).map((e) => ({
		code: typeof e.code === 'number' ? e.code : null,
		message: e.message ?? (typeof e.code === 'number' ? `code ${e.code}` : 'unknown error')
	}));
}

/**
 * Reads one Cloudflare envelope.
 *
 * A 200 carrying `success: false` is the normal way this API reports a permission problem, so the
 * status code alone is never the check; treating it as one is how "no workers" gets confused with a
 * token that may not list them.
 */
export async function readEnvelope<T>(response: Response, what: string): Promise<T> {
	let body: ApiEnvelope<T>;
	try {
		body = (await response.json()) as ApiEnvelope<T>;
	} catch (cause) {
		throw new TransportError(`${what}: HTTP ${response.status} with a non-JSON body`, {
			cause
		});
	}
	const details = detailsOf(body);
	const detail = details.map((d) => d.message).join('; ');

	if (response.status === 401 || response.status === 403) {
		throw new AuthError(
			`${what}: HTTP ${response.status}, the credential was rejected${detail === '' ? '' : ` (${detail})`}`
		);
	}
	if (response.status === 404) {
		throw new NotFoundError(`${what}: not found${detail === '' ? '' : ` (${detail})`}`);
	}
	if (body.success === false || body.result === undefined) {
		throw new ApiError(
			`${what}: ${detail === '' ? `HTTP ${response.status}` : detail}`,
			response.status,
			details
		);
	}
	return body.result;
}

/** the same read, keeping `result_info` so a pager can see where it is */
export async function readPage<T>(
	response: Response,
	what: string
): Promise<{ result: T; info: ResultInfo }> {
	const clone = response.clone();
	const result = await readEnvelope<T>(response, what);
	const body = (await clone.json()) as ApiEnvelope<T>;
	return { result, info: body.result_info ?? {} };
}

/**
 * One authenticated call, with the budget and the retry policy around it.
 *
 * Retries only what is worth retrying, and a 429 is paced by the server's own `Retry-After` rather
 * than by a guess, because guessing on this API is how a five-minute lockout becomes a longer one.
 */
export class HttpClient {
	readonly baseUrl: string;
	readonly budget: Budget;

	private readonly fetcher: Fetcher;
	private readonly retries: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly extraHeaders: Record<string, string>;

	constructor(
		private readonly authorize: () => Record<string, string>,
		options: ClientOptions = {}
	) {
		this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.baseUrl = (options.baseUrl ?? API_BASE).replace(/\/+$/, '');
		this.budget = options.budget ?? new Budget();
		this.retries = options.retries ?? 3;
		this.sleep = options.sleep ?? defaultSleep;
		this.now = options.now ?? (() => Date.now());
		this.extraHeaders = options.headers ?? {};
	}

	/** the escape hatch: any path, any method, the envelope read for you */
	async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.send(path, options);
		return readEnvelope<T>(response, `${options.method ?? 'GET'} ${path}`);
	}

	/** the same call, with `result_info` kept */
	async requestPage<T>(
		path: string,
		options: RequestOptions = {}
	): Promise<{ result: T; info: ResultInfo }> {
		const response = await this.send(path, options);
		return readPage<T>(response, `${options.method ?? 'GET'} ${path}`);
	}

	/** no envelope: for content downloads and anything that answers with bytes */
	async send(path: string, options: RequestOptions = {}): Promise<Response> {
		const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}${buildQuery(options.query)}`;
		const headers: Record<string, string> = {
			accept: 'application/json',
			...this.extraHeaders,
			...this.authorize(),
			...(options.headers ?? {})
		};

		let attempt = 0;
		for (;;) {
			await this.budget.acquire();
			let response: Response;
			try {
				response = await this.fetcher(url, {
					method: options.method ?? 'GET',
					headers,
					body: options.body ?? null,
					signal: options.signal
				});
			} catch (cause) {
				this.budget.release();
				if (attempt >= this.retries) {
					throw new TransportError(`${options.method ?? 'GET'} ${path} never answered`, {
						cause
					});
				}
				await this.sleep(backoffMs(attempt));
				attempt += 1;
				continue;
			}
			this.budget.observe(response.headers);
			this.budget.release();

			if (response.status === 429) {
				const wait = this.budget.penalise(response.headers);
				if (attempt >= this.retries) {
					throw new LimitError(
						`${options.method ?? 'GET'} ${path}: rate limited, and the whole account is blocked until this window resets`,
						wait
					);
				}
				await this.sleep(wait);
				attempt += 1;
				continue;
			}

			if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
				const named = readRetryAfter(response.headers, this.now());
				await this.sleep(named ?? backoffMs(attempt));
				attempt += 1;
				continue;
			}

			return response;
		}
	}
}

/** exponential with jitter, so a fleet retrying together does not retry together twice */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(30_000, 250 * 2 ** attempt);
	return Math.round(base / 2 + random() * (base / 2));
}
