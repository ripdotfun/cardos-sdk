/**
 * Error hierarchy for the CardOS SDK.
 *
 * Every failed HTTP call throws a `CardOSError` (or a subclass keyed by status).
 * `code` is the API's stable machine error code (`insufficient_funds`,
 * `sold_out`, `idempotency_mismatch`, …) — branch on that, not on `message`.
 * Non-HTTP failures (network, timeout, polling) have their own classes so a
 * `try/catch` can tell "the API said no" from "we never heard back".
 */

export interface CardOSErrorOptions {
  status: number;
  code: string;
  message: string;
  /** Raw parsed response body, when there was one. */
  body?: unknown;
  /** Response headers. */
  headers?: Headers;
  /** `X-Request-Id` / `X-Mystery-Delivery` style correlation id, when present. */
  requestId?: string | null;
  /** `Retry-After` in milliseconds, when the API sent one. */
  retryAfterMs?: number | null;
  /** Extra structured detail the API attached (e.g. `details.position` on invalid_query). */
  details?: unknown;
  /** Endpoint that failed, for diagnostics. */
  method?: string;
  path?: string;
}

export class CardOSError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly headers: Headers | undefined;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly details: unknown;
  readonly method: string | undefined;
  readonly path: string | undefined;

  constructor(opts: CardOSErrorOptions) {
    super(opts.message);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    this.headers = opts.headers;
    this.requestId = opts.requestId ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.details = opts.details;
    this.method = opts.method;
    this.path = opts.path;
  }

  /** True for errors the API explicitly marks retryable, or transient statuses. */
  get retryable(): boolean {
    const b = this.body as { retryable?: unknown } | undefined;
    if (b && typeof b === "object" && typeof b.retryable === "boolean") return b.retryable;
    return this.status === 429 || this.status === 503 || this.status === 502 || this.status === 504;
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      details: this.details,
      method: this.method,
      path: this.path,
    };
  }
}

/** 400 — the request was malformed (`invalid_query`, `invalid_tier`, `missing_idempotency_key`, …). */
export class ValidationError extends CardOSError {}
/** 401 — missing / invalid / expired API key. */
export class AuthenticationError extends CardOSError {}
/** 402 — the end user's custodial balance is too low (`insufficient_funds`). */
export class InsufficientFundsError extends CardOSError {}
/** 403 — the key lacks the scope, or is not a mystery-partner key. */
export class PermissionError extends CardOSError {}
/** 404 — `not_found`, `token_not_found`, `value_unknown` (on /price), … */
export class NotFoundError extends CardOSError {}
/** 409 — state conflict: `sold_out`, `idempotency_mismatch`, `offer_exists`, `redemption_exists`, … */
export class ConflictError extends CardOSError {}
/** 422 — accepted shape, rejected semantics (e.g. a carrier refused the label). */
export class UnprocessableError extends CardOSError {}
/** 429 — `rate_limited`. `retryAfterMs` says how long to wait. */
export class RateLimitError extends CardOSError {}
/** 503 — `overloaded`, `timeout`, `relayer_disabled`, `instant_disabled`, … */
export class ServiceUnavailableError extends CardOSError {}
/** Any other 5xx (`internal_error`). */
export class ServerError extends CardOSError {}

/** The request never completed — DNS, TLS, socket reset. Wraps the underlying cause. */
export class ConnectionError extends Error {
  readonly cause: unknown;
  readonly method: string | undefined;
  readonly path: string | undefined;
  constructor(message: string, cause: unknown, method?: string, path?: string) {
    super(message);
    this.name = "ConnectionError";
    this.cause = cause;
    this.method = method;
    this.path = path;
  }
}

/** The request exceeded `timeoutMs` (or the caller's AbortSignal fired). */
export class TimeoutError extends Error {
  readonly method: string | undefined;
  readonly path: string | undefined;
  constructor(message: string, method?: string, path?: string) {
    super(message);
    this.name = "TimeoutError";
    this.method = method;
    this.path = path;
  }
}

/** A `waitFor*` helper gave up before the resource reached a terminal state. Carries the last state seen. */
export class PollTimeoutError<T = unknown> extends Error {
  readonly lastValue: T | undefined;
  constructor(message: string, lastValue?: T) {
    super(message);
    this.name = "PollTimeoutError";
    this.lastValue = lastValue;
  }
}

/**
 * A `waitFor*` helper saw the resource reach a terminal FAILED / REFUNDED
 * state. `value` is the final resource so the caller can read `failure_reason`.
 */
export class TerminalStateError<T = unknown> extends Error {
  readonly value: T;
  readonly state: string;
  constructor(message: string, state: string, value: T) {
    super(message);
    this.name = "TerminalStateError";
    this.state = state;
    this.value = value;
  }
}

/** Thrown by webhook signature verification. */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export function errorClassForStatus(status: number): typeof CardOSError {
  switch (status) {
    case 400:
      return ValidationError;
    case 401:
      return AuthenticationError;
    case 402:
      return InsufficientFundsError;
    case 403:
      return PermissionError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 422:
      return UnprocessableError;
    case 429:
      return RateLimitError;
    case 503:
      return ServiceUnavailableError;
    default:
      return status >= 500 ? ServerError : CardOSError;
  }
}
