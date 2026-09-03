/**
 * The one place the SDK talks HTTP.
 *
 * Responsibilities: base URL + auth header, query encoding, JSON bodies,
 * idempotency keys, per-request timeouts, bounded retries on transient
 * failures (honouring Retry-After), and turning the API's error envelope into a
 * typed `CardOSError`. Resources never touch `fetch` directly.
 */

import {
  CardOSError,
  ConnectionError,
  TimeoutError,
  errorClassForStatus,
} from "./errors.js";
import type { ErrorEnvelope, RequestOverrides } from "./types/common.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface HttpRequest extends RequestOverrides {
  method: HttpMethod;
  /** Absolute path under the base URL, e.g. `/api/v1/mystery/catalog`. */
  path: string;
  /** Query params. `undefined` / `null` are skipped; arrays are comma-joined. */
  query?: Query;
  /** JSON body (objects) or a `FormData` for multipart uploads. */
  body?: unknown;
  /** Sent as `Idempotency-Key`. Also makes a POST eligible for retry. */
  idempotencyKey?: string;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: HttpClientOptions) {
    if (!opts.apiKey) throw new Error("CardOS: apiKey is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error("CardOS: no fetch implementation found — pass one via options.fetch");
    }
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.userAgent = opts.userAgent ?? `cardos-sdk/${SDK_VERSION}`;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  /** Full parsed body (the envelope). Throws a typed `CardOSError` on any non-2xx or `success:false`. */
  async request<T = unknown>(req: HttpRequest): Promise<T> {
    const res = await this.raw<T>(req);
    return res.body;
  }

  /** `body.data` from a standard `{ success, data }` envelope. */
  async data<T = unknown>(req: HttpRequest): Promise<T> {
    const body = (await this.request<{ data: T }>(req)) as { data: T };
    return body.data;
  }

  /** Parsed body plus status and headers, for callers that need `pagination` or headers. */
  async raw<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = this.buildUrl(req.path, req.query);
    const headers = this.buildHeaders(req);
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined && req.method !== "GET") {
      if (typeof FormData !== "undefined" && req.body instanceof FormData) {
        init.body = req.body;
      } else {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body);
      }
    }

    const maxRetries = req.maxRetries ?? this.maxRetries;
    const retryable = req.method === "GET" || req.method === "DELETE" || !!req.idempotencyKey;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, init, timeoutMs, req.signal, req);
      } catch (err) {
        if (err instanceof TimeoutError && req.signal?.aborted) throw err;
        if (retryable && attempt < maxRetries && !(req.signal?.aborted)) {
          await sleep(backoff(attempt++), req.signal);
          continue;
        }
        throw err;
      }

      const parsed = await parseBody(response);
      if (response.ok && !isErrorEnvelope(parsed)) {
        return { status: response.status, headers: response.headers, body: parsed as T };
      }

      const error = toError(response, parsed, req);
      const shouldRetry =
        retryable && attempt < maxRetries && (response.status === 429 || response.status >= 502);
      if (shouldRetry) {
        const wait = error.retryAfterMs ?? backoff(attempt);
        attempt++;
        await sleep(Math.min(wait, RETRY_MAX_MS), req.signal);
        continue;
      }
      throw error;
    }
  }

  buildUrl(path: string, query?: Query): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl + "/");
    // `new URL` with a leading-slash path drops any base path; re-prefix it.
    const base = new URL(this.baseUrl);
    if (base.pathname !== "/" && !url.pathname.startsWith(base.pathname)) {
      url.pathname = base.pathname.replace(/\/$/, "") + url.pathname;
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          if (v.length) url.searchParams.set(k, v.join(","));
        } else if (typeof v === "boolean") {
          url.searchParams.set(k, v ? "true" : "false");
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private buildHeaders(req: HttpRequest): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "x-api-key": this.apiKey,
      ...this.defaultHeaders,
      ...(req.headers ?? {}),
    };
    // Browsers forbid setting User-Agent; Node honours it.
    if (typeof window === "undefined") h["user-agent"] = this.userAgent;
    if (req.idempotencyKey) h["idempotency-key"] = req.idempotencyKey;
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    outer: AbortSignal | undefined,
    req: HttpRequest,
  ): Promise<Response> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) throw new TimeoutError("Request aborted", req.method, req.path);
      outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new TimeoutError(`Request timed out after ${timeoutMs}ms`, req.method, req.path)), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof TimeoutError) throw reason;
        throw new TimeoutError(
          outer?.aborted ? "Request aborted" : `Request timed out after ${timeoutMs}ms`,
          req.method,
          req.path,
        );
      }
      throw new ConnectionError(
        `Network error calling ${req.method} ${req.path}: ${(err as Error)?.message ?? String(err)}`,
        err,
        req.method,
        req.path,
      );
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
}

export const SDK_VERSION = "0.1.1";

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isErrorEnvelope(x: unknown): x is ErrorEnvelope {
  return !!x && typeof x === "object" && (x as { success?: unknown }).success === false;
}

function toError(res: Response, body: unknown, req: HttpRequest): CardOSError {
  const env = (body ?? {}) as Partial<ErrorEnvelope> & { raw?: string; code?: string };
  const code =
    (typeof env.error === "string" && env.error) ||
    (typeof env.code === "string" && env.code) ||
    defaultCode(res.status);
  const message =
    (typeof env.message === "string" && env.message) ||
    (typeof env.error === "string" && env.error !== code && env.error) ||
    (env.raw ? env.raw.slice(0, 200) : `${req.method} ${req.path} failed with HTTP ${res.status}`);
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : null;
  const Cls = errorClassForStatus(res.status);
  return new Cls({
    status: res.status,
    code,
    message: `${message} (${code})`,
    body,
    headers: res.headers,
    requestId: res.headers.get("x-request-id") ?? res.headers.get("x-amzn-requestid"),
    retryAfterMs,
    details: env.details,
    method: req.method,
    path: req.path,
  });
}

function defaultCode(status: number): string {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    case 503:
      return "overloaded";
    default:
      return status >= 500 ? "internal_error" : "request_failed";
  }
}

function parseRetryAfter(v: string): number | null {
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function backoff(attempt: number): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TimeoutError("Aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TimeoutError("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** RFC-4122 v4 id for `Idempotency-Key` headers. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for very old runtimes.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
