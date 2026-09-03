import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConflictError,
  InsufficientFundsError,
  RateLimitError,
  ValidationError,
  ENVIRONMENT_URLS,
} from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

describe("HttpClient", () => {
  it("sends X-API-Key and hits the production host by default", async () => {
    const fx = mockFetch([ok({ tiers: [] })]);
    const c = makeClient(fx);
    await c.http.data({ method: "GET", path: "/api/v1/mystery/catalog" });
    expect(fx.last.url.origin).toBe(ENVIRONMENT_URLS.production);
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/catalog");
    expect(fx.last.headers["x-api-key"]).toBe("rip_v1_test");
  });

  it("uses the staging host when asked", async () => {
    const fx = mockFetch([ok({})]);
    const c = makeClient(fx, { environment: "staging" });
    await c.http.data({ method: "GET", path: "/x" });
    expect(fx.last.url.origin).toBe(ENVIRONMENT_URLS.staging);
  });

  it("encodes query params, skipping undefined and joining arrays", async () => {
    const fx = mockFetch([ok({})]);
    const c = makeClient(fx);
    await c.http.data({
      method: "GET",
      path: "/q",
      query: { limit: 10, offset: undefined, scope: null, ids: ["a", "b"], fresh: true },
    });
    expect(fx.last.url.search).toBe("?limit=10&ids=a%2Cb&fresh=true");
  });

  it("JSON-encodes bodies and sends Idempotency-Key", async () => {
    const fx = mockFetch([ok({ id: 1 })]);
    const c = makeClient(fx);
    await c.http.data({ method: "POST", path: "/p", body: { tier_id: 3 }, idempotencyKey: "k-1" });
    expect(fx.last.method).toBe("POST");
    expect(fx.last.headers["content-type"]).toBe("application/json");
    expect(fx.last.headers["idempotency-key"]).toBe("k-1");
    expect(fx.last.body).toEqual({ tier_id: 3 });
  });

  it("maps error envelopes to typed errors with the machine code", async () => {
    const cases: Array<[number, string, unknown]> = [
      [400, "invalid_tier", ValidationError],
      [401, "unauthorized", AuthenticationError],
      [402, "insufficient_funds", InsufficientFundsError],
      [409, "sold_out", ConflictError],
      [429, "rate_limited", RateLimitError],
    ];
    for (const [status, code, Cls] of cases) {
      const fx = mockFetch([fail(status, code, "nope")]);
      const c = makeClient(fx);
      const err = (await c.http.data({ method: "GET", path: "/e" }).catch((e: unknown) => e)) as { status: number; code: string; message: string };
      expect(err).toBeInstanceOf(Cls);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.message).toContain("nope");
    }
  });

  it("parses Retry-After on 429 and retries GETs when allowed", async () => {
    const fx = mockFetch([fail(429, "rate_limited", "slow down", {}), ok({ fine: true })]);
    fx.calls.length = 0;
    const c = makeClient(fx, { maxRetries: 1 });
    const data = await c.http.data<{ fine: boolean }>({ method: "GET", path: "/r" });
    expect(data.fine).toBe(true);
    expect(fx.calls.length).toBe(2);
  });

  it("does not retry a non-idempotent POST", async () => {
    const fx = mockFetch([fail(503, "overloaded"), ok({})]);
    const c = makeClient(fx, { maxRetries: 2 });
    await expect(c.http.data({ method: "POST", path: "/np", body: {} })).rejects.toMatchObject({ code: "overloaded" });
    expect(fx.calls.length).toBe(1);
  });

  it("treats success:false with 200 as an error", async () => {
    const fx = mockFetch([{ status: 200, body: { success: false, error: "weird", message: "odd" } }]);
    const c = makeClient(fx);
    await expect(c.http.data({ method: "GET", path: "/w" })).rejects.toMatchObject({ code: "weird", status: 200 });
  });
});
