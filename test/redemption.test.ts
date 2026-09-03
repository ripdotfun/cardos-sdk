import { describe, expect, it } from "vitest";
import { ConflictError, PollTimeoutError, TerminalStateError } from "../src/index.js";
import type {
  Redemption,
  RedemptionPrepareResult,
  RedemptionShippingAddress,
  RedemptionShippingQuote,
} from "../src/index.js";
import { accepted, fail, makeClient, mockFetch, ok } from "./helpers.js";

const shipping_address: RedemptionShippingAddress = {
  name: "Ada Lovelace",
  street1: "12 Analytical Way",
  city: "London",
  zip: "EC1A 1AA",
  country: "GB",
};

const QUOTE: RedemptionShippingQuote = {
  amount_usdc: "5.420000",
  currency: "USD",
  carrier: "USPS",
  service: "Priority Mail",
  service_token: "usps_priority",
  estimated_days: 3,
  rate_id: "rate_abc",
  quoted_at: "2026-09-01T10:00:00.000Z",
};

const PREPARED: RedemptionPrepareResult = {
  redemption_id: 31,
  status: "PREPARED",
  item_type: "CARD",
  token_id: "10231",
  shipping_quote: QUOTE,
  shipping_payer: "end_user",
  shipping_payment: {
    payer: "0xholder",
    processor: "0xprocessor",
    total_usdc: "5.420000",
    total_micros: "5420000",
    expiration_time: 1788000000,
    provider_order_id: "ord_9",
  },
  expires_at: "2026-09-02T10:00:00.000Z",
  unsigned: {
    chain_id: 8453,
    calls: [
      { to: "0xcard", data: "0x01", kind: "burn", description: "Initiate redemption burn (CARD)" },
      { to: "0xusdc", data: "0x02", kind: "erc20-approve", description: "Approve USDC for shipping" },
      { to: "0xprocessor", data: "0x03", kind: "shipping-payment", description: "Pay shipping" },
    ],
  },
};

function redemption(over: Partial<Redemption> = {}): Redemption {
  return {
    redemption_id: 31,
    purchase_id: null,
    token_id: "10231",
    item_type: "CARD",
    status: "PREPARED",
    burn: {
      db_status: "PENDING_REDEEM",
      is_burned: false,
      burn_type: 1,
      burn_type_label: "REDEEM_CARD",
    },
    queue: { status: "PENDING" },
    order: { status: null, tracking_number: null },
    burn_tx_hash: null,
    shipping_quote: QUOTE,
    failure_reason: null,
    expires_at: "2026-09-02T10:00:00.000Z",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

describe("redemption.quote", () => {
  it("POSTs the target plus address and unwraps shipping_quote", async () => {
    const fx = mockFetch([ok({ shipping_quote: QUOTE })]);
    const quote = await makeClient(fx).redemption.quote({
      token_id: "10231",
      shipping_address,
    });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/redemption/quote");
    expect(fx.last.body).toEqual({ token_id: "10231", shipping_address });
    expect(quote.amount_usdc).toBe("5.420000");
    expect(quote.service_token).toBe("usps_priority");
  });

  it("maps 409 not_fulfilled to ConflictError", async () => {
    const fx = mockFetch([fail(409, "not_fulfilled", "Purchase has not revealed yet")]);
    const err = await makeClient(fx)
      .redemption.quote({ purchase_id: 7, shipping_address })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe("not_fulfilled");
  });
});

describe("redemption.prepare", () => {
  it("generates an Idempotency-Key and returns the ordered calls", async () => {
    const fx = mockFetch([ok(PREPARED)]);
    const prepared = await makeClient(fx).redemption.prepare({
      token_id: "10231",
      shipping_address,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/redemption/prepare");
    expect(fx.last.body).toEqual({ token_id: "10231", shipping_address });
    expect(fx.last.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.unsigned!.calls.map((c) => c.kind)).toEqual([
      "burn",
      "erc20-approve",
      "shipping-payment",
    ]);
    expect(prepared.shipping_payer).toBe("end_user");
  });

  it("passes a caller-supplied idempotency_key as the header only", async () => {
    const fx = mockFetch([ok(PREPARED)]);
    await makeClient(fx).redemption.prepare({
      purchase_id: 7,
      token_id: "10231",
      shipping_address,
      idempotency_key: "redeem-7-10231",
    });

    expect(fx.last.headers["idempotency-key"]).toBe("redeem-7-10231");
    expect(fx.last.body).toEqual({ purchase_id: 7, token_id: "10231", shipping_address });
  });
});

describe("redemption.submit", () => {
  it("records the burn tx", async () => {
    const fx = mockFetch([
      accepted({
        redemption_id: 31,
        status: "BURN_SUBMITTED",
        burn_tx_hash: `0x${"b".repeat(64)}`,
        tracking_number: "9400111",
      }),
    ]);
    const result = await makeClient(fx).redemption.submit({
      redemption_id: 31,
      tx_hash: `0x${"b".repeat(64)}`,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/redemption/submit");
    expect(fx.last.body).toEqual({ redemption_id: 31, tx_hash: `0x${"b".repeat(64)}` });
    expect(result.status).toBe("BURN_SUBMITTED");
    expect(result.tracking_number).toBe("9400111");
  });
});

describe("redemption.get / list", () => {
  it("reads by token id with verify and unwraps the array", async () => {
    const fx = mockFetch([ok({ redemptions: [redemption()] })]);
    const rows = await makeClient(fx).redemption.get("10231", { verify: true });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/redemption/10231");
    expect(fx.last.url.searchParams.get("verify")).toBe("true");
    expect(rows[0]!.burn.burn_type_label).toBe("REDEEM_CARD");
  });

  it("pages partner-wide history filtered by status", async () => {
    const fx = mockFetch([
      ok(
        { redemptions: [redemption({ status: "IN_FULFILLMENT" })] },
        { pagination: { limit: 1, offset: 0, has_more: true } },
      ),
      ok(
        { redemptions: [redemption({ redemption_id: 32, status: "IN_FULFILLMENT" })] },
        { pagination: { limit: 1, offset: 1, has_more: false } },
      ),
    ]);
    const first = await makeClient(fx).redemption.list({ status: "IN_FULFILLMENT", limit: 1 });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/redemptions");
    expect(fx.last.url.searchParams.get("status")).toBe("IN_FULFILLMENT");

    const second = await first.next();
    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(second!.items[0]!.redemption_id).toBe(32);
    expect(await second!.next()).toBeNull();
  });
});

describe("redemption.waitForCompletion", () => {
  it("polls the prepare result's token id and picks the matching redemption", async () => {
    const fx = mockFetch([
      ok({
        redemptions: [
          redemption({ redemption_id: 30, status: "CANCELLED" }),
          redemption({ status: "IN_FULFILLMENT" }),
        ],
      }),
      ok({
        redemptions: [
          redemption({ redemption_id: 30, status: "CANCELLED" }),
          redemption({ status: "COMPLETED" }),
        ],
      }),
    ]);
    const row = await makeClient(fx).redemption.waitForCompletion(PREPARED, {
      intervalMs: 1,
      maxIntervalMs: 1,
      timeoutMs: 500,
    });

    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/mystery/redemption/10231");
    expect(fx.calls).toHaveLength(2);
    expect(row.redemption_id).toBe(31);
    expect(row.status).toBe("COMPLETED");
  });

  it("resolves once the order is COMPLETED", async () => {
    const fx = mockFetch([
      ok({ redemptions: [redemption({ status: "IN_FULFILLMENT" })] }),
      ok({
        redemptions: [
          redemption({
            status: "COMPLETED",
            order: { status: "SHIPPED", tracking_number: "9400111" },
            burn: {
              db_status: "BURNED",
              is_burned: true,
              burn_type: 1,
              burn_type_label: "REDEEM_CARD",
            },
          }),
        ],
      }),
    ]);
    const row = await makeClient(fx).redemption.waitForCompletion("10231", {
      intervalMs: 1,
      maxIntervalMs: 1,
      timeoutMs: 500,
    });

    expect(fx.calls).toHaveLength(2);
    expect(row.order.tracking_number).toBe("9400111");
    expect(row.burn.is_burned).toBe(true);
  });

  it("throws TerminalStateError on FAILED", async () => {
    const fx = mockFetch([
      ok({ redemptions: [redemption({ status: "FAILED", failure_reason: "address_undeliverable" })] }),
    ]);
    const err = await makeClient(fx)
      .redemption.waitForCompletion("10231", { intervalMs: 1, timeoutMs: 500 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TerminalStateError);
    expect((err as TerminalStateError).state).toBe("FAILED");
  });

  it("times out rather than waiting out a real shipment", async () => {
    const fx = mockFetch([ok({ redemptions: [redemption({ status: "IN_FULFILLMENT" })] })]);
    const err = await makeClient(fx)
      .redemption.waitForCompletion("10231", { intervalMs: 5, timeoutMs: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollTimeoutError);
  });
});
