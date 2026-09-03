/**
 * Test doubles. `mockFetch` records every call and answers from a queue of
 * canned responses, so a resource test can assert the exact path / query /
 * body the SDK sent and feed back the envelope the API would return.
 */
import { CardOS, type CardOSOptions } from "../src/index.js";

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CannedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function mockFetch(responses: CannedResponse[] = []) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body) {
      body = init.body;
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const next = queue.shift() ?? { status: 200, body: { success: true, data: {} } };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  };
  return {
    fetch: fetchImpl,
    calls,
    /** Push more responses after construction. */
    respond(...more: CannedResponse[]) {
      queue.push(...more);
    },
    get last() {
      return calls[calls.length - 1]!;
    },
  };
}

export function ok<T>(data: T, extra: Record<string, unknown> = {}): CannedResponse {
  return { status: 200, body: { success: true, data, ...extra } };
}

export function accepted<T>(data: T): CannedResponse {
  return { status: 202, body: { success: true, data } };
}

export function fail(status: number, error: string, message = error, extra: Record<string, unknown> = {}): CannedResponse {
  return { status, body: { success: false, error, message, ...extra } };
}

export function makeClient(fx: ReturnType<typeof mockFetch>, opts: Partial<CardOSOptions> = {}) {
  return new CardOS({ apiKey: "rip_v1_test", fetch: fx.fetch, maxRetries: 0, ...opts });
}
