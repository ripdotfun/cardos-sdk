import { describe, expect, it } from "vitest";
import { PermissionError } from "../src/index.js";
import type { SellbackQuote, SellbackRecord } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

const QUOTE: SellbackQuote = {
  seller: "0xholder",
  items: [
    {
      token_id: "10231",
      eligible: true,
      reason: null,
      expires_at: "2026-12-01T00:00:00.000Z",
      group_id: 7,
      oracle_value_usdc: "20.000000",
      payout_usdc: "17.000000",
      payout_micros: "17000000",
      from_raw_card_pack: true,
    },
    {
      token_id: "10232",
      eligible: false,
      reason: "window_expired",
      expires_at: "2026-01-01T00:00:00.000Z",
      group_id: 7,
      oracle_value_usdc: null,
      payout_usdc: null,
      payout_micros: null,
      from_raw_card_pack: false,
    },
  ],
  eligible_token_ids: ["10231"],
  total_payout_micros: "17000000",
  total_payout_usdc: "17.000000",
  approval_needed: true,
  pool_liquidity_usdc: "50000.000000",
  sufficient_liquidity: true,
};

const RECORD: SellbackRecord = {
  sellback_id: 12,
  seller: "0xholder",
  item_type: "CARD",
  token_ids: ["10231"],
  total_usdc: "17.000000",
  total_micros: "17000000",
  raw_card_count: 1,
  transaction_hash: `0x${"a".repeat(64)}`,
  sold_at: "2026-09-01T12:00:00.000Z",
};

describe("sellback.quote", () => {
  it("POSTs the holder and tokens and reports per-card eligibility", async () => {
    const fx = mockFetch([ok(QUOTE)]);
    const quote = await makeClient(fx).sellback.quote({
      wallet_address: "0xholder",
      token_ids: ["10231", "10232"],
    });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/sellback/quote");
    expect(fx.last.body).toEqual({
      wallet_address: "0xholder",
      token_ids: ["10231", "10232"],
    });
    expect(quote.eligible_token_ids).toEqual(["10231"]);
    expect(quote.items[1]!.reason).toBe("window_expired");
    expect(quote.approval_needed).toBe(true);
  });

  it("maps 403 not_tier_partner to PermissionError", async () => {
    const fx = mockFetch([
      fail(403, "not_tier_partner", "Your account sells its own inventory"),
    ]);
    const err = await makeClient(fx)
      .sellback.quote({ wallet_address: "0xholder", token_ids: ["1"] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect((err as PermissionError).code).toBe("not_tier_partner");
  });
});

describe("sellback.prepare", () => {
  it("returns the approval + sellback calls, in order, with kinds", async () => {
    const fx = mockFetch([
      ok({
        chain_id: 8453,
        contract: "0xcombo",
        card_contract: "0xcard",
        buyback_pool: "0xpool",
        seller: "0xholder",
        token_ids: ["10231"],
        quoted_payout_usdc: "17.000000",
        min_total: "16830000",
        min_total_usdc: "16.830000",
        approval_needed: true,
        calls: [
          { to: "0xcard", data: "0x01", kind: "set-approval-for-all", description: "Approve BuybackPool to transfer your cards (one-time)" },
          { to: "0xcombo", data: "0x02", kind: "sellback", description: "Sell cards back to the combo pool" },
        ],
      }),
    ]);
    const prepared = await makeClient(fx).sellback.prepare({
      wallet_address: "0xholder",
      token_ids: ["10231"],
      slippage_bps: 100,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/sellback/prepare");
    expect(fx.last.body).toEqual({
      wallet_address: "0xholder",
      token_ids: ["10231"],
      slippage_bps: 100,
    });
    expect(prepared.calls.map((c) => c.kind)).toEqual(["set-approval-for-all", "sellback"]);
    expect(prepared.min_total_usdc).toBe("16.830000");
  });
});

describe("sellback.submit", () => {
  it("records a broadcast sale and echoes the on-chain payout", async () => {
    const fx = mockFetch([ok(RECORD)]);
    const row = await makeClient(fx).sellback.submit({
      transaction_hash: `0x${"a".repeat(64)}`,
      wallet_address: "0xholder",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/sellback/submit");
    expect(fx.last.body).toEqual({
      transaction_hash: `0x${"a".repeat(64)}`,
      wallet_address: "0xholder",
    });
    expect(row.total_usdc).toBe("17.000000");
    expect(row.raw_card_count).toBe(1);
  });
});

describe("sellback.list", () => {
  it("pages through history", async () => {
    const fx = mockFetch([
      ok({ sellbacks: [RECORD] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok(
        { sellbacks: [{ ...RECORD, sellback_id: 13 }] },
        { pagination: { limit: 1, offset: 1, has_more: false } },
      ),
    ]);
    const first = await makeClient(fx).sellback.list({ limit: 1 });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/sellbacks");
    expect(fx.last.url.searchParams.get("limit")).toBe("1");
    expect(first.items[0]!.sellback_id).toBe(12);

    const second = await first.next();
    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(second!.items[0]!.sellback_id).toBe(13);
    expect(await second!.next()).toBeNull();
  });
});
