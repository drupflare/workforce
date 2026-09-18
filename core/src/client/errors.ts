/**
 * The error vocabulary, and every refusal in this library is one of these.
 *
 * A caller should be able to branch on `kind` without parsing a message, which is why the Cloudflare
 * envelope's own error list is carried on {@link ApiError} rather than flattened into text.
 */

export type ErrorKind =
	'auth' | 'api' | 'limit' | 'not-found' | 'capability' | 'usage' | 'transport';

export class WorkforceError extends Error {
	readonly kind: ErrorKind;

	constructor(kind: ErrorKind, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.kind = kind;
	}
}

/** the credential was missing, malformed or rejected */
export class AuthError extends WorkforceError {
	constructor(message: string, options?: ErrorOptions) {
		super('auth', message, options);
	}
}

/** one error the Cloudflare envelope reported */
export interface ApiErrorDetail {
	code: number | null;
	message: string;
}

/**
 * The API answered and said no.
 *
 * `status` is the HTTP status, which on this API is frequently 200 with `success: false`, so branch
 * on {@link ApiError.errors} rather than on the status when you need a specific cause.
 */
export class ApiError extends WorkforceError {
	readonly status: number;
	readonly errors: readonly ApiErrorDetail[];

	constructor(
		message: string,
		status: number,
		errors: readonly ApiErrorDetail[] = [],
		options?: ErrorOptions
	) {
		super('api', message, options);
		this.status = status;
		this.errors = errors;
	}

	/** whether any reported error carries this code, which is how Cloudflare names a specific cause */
	hasCode(code: number): boolean {
		return this.errors.some((e) => e.code === code);
	}
}

/**
 * A rate limit or a quota refused the call.
 *
 * `retryAfterMs` is null when the response named no wait, which is not the same as zero: a caller
 * that treats null as "retry now" turns one refusal into a loop.
 */
export class LimitError extends WorkforceError {
	readonly retryAfterMs: number | null;

	constructor(message: string, retryAfterMs: number | null = null, options?: ErrorOptions) {
		super('limit', message, options);
		this.retryAfterMs = retryAfterMs;
	}
}

export class NotFoundError extends WorkforceError {
	constructor(message: string, options?: ErrorOptions) {
		super('not-found', message, options);
	}
}

/**
 * The plane cannot do this at all, and the reason is a property of the plane rather than of the call.
 *
 * Thrown before any request is made, so a dispatch-namespace script asking for a version list never
 * produces a 404 the caller has to interpret.
 */
export class CapabilityError extends WorkforceError {
	readonly plane: string;
	readonly capability: string;

	constructor(plane: string, capability: string, reason: string, options?: ErrorOptions) {
		super('capability', `${plane} does not support ${capability}: ${reason}`, options);
		this.plane = plane;
		this.capability = capability;
	}
}

/** the caller passed something this library can reject without asking the API */
export class UsageError extends WorkforceError {
	constructor(message: string, options?: ErrorOptions) {
		super('usage', message, options);
	}
}

/** the request never produced a response, or produced one that could not be read */
export class TransportError extends WorkforceError {
	constructor(message: string, options?: ErrorOptions) {
		super('transport', message, options);
	}
}
