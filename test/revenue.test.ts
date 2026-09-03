import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/index.js";
import type { RevenuePayout, RevenueSummary, RevenueTerms } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

const BY_PRODUCT = {
  tier: {
    packs: 40,
    gross_usdc: "1000.000000",
    sellback_count: 3,
    sellback_usdc: "120.000000",
    net_usdc: "880.000000",
    share_bps: 500,
    share_usdc: "44.000000",
  },
  instant: {
    packs: 10,
    gross_usdc: "49.900000",
    sellback_usdc: "0.000000",
    net_usdc: "49.900000",
    share_bps: 100,
    share_usdc: "0.499000",
  },
};

const SUMMARY: RevenueSummary = {
  billing_model: "TIER",
  revenue_share_bps: 500,
  instant_revenue_share_bps: 100,
  period: { from: "2026-07-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
  by_product: BY_PRODUCT,
  qualifying_packs: 40,
  instant_packs: 10,
  gross_micros: "1049900000",
  gross_usdc: "1049.900000",
  sellback_count: 3,
  sellback_micros: "120000000",
  sellback_usdc: "120.000000",
  net_micros: "929900000",
  net_usdc: "929.900000",
  revenue_share_micros: "44499000",
  revenue_share_usdc: "44.499000",
  payout_micros: "44499000",
  payout_usdc: "44.499000",
  rip_retained_micros: "885401000",
  rip_retained_usdc: "885.401000",
  fees_micros: "0",
  fees_usdc: "0.000000",
  components: {
    tier_gross_micros: "1000000000",
    tier_sellback_micros: "120000000",
    tier_net_micros: "880000000",
    tier_share_micros: "44000000",
    instant_gross_micros: "49900000",
    instant_net_micros: "49900000",
    instant_share_micros: "499000",
  },
  note: "revenue_share is what YOU earn.",
};

const TERMS: RevenueTerms = {
  billing_model: "TIER",
  plan: "STANDARD",
  revenue_share_bps: 500,
  revenue_share_pct: "5.00",
  instant_revenue_share_bps: 100,
  instant_revenue_share_pct: "1.00",
  payout_schedule: "QUARTERLY",
  payout_currency: "USDC",
  payout_wallet: { chain: "base", address: "0xpayout" },
  current_period: {
    kind: "QUARTERLY",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    closes_at: "2026-10-01T00:00:00.000Z",
  },
  note: "You earn revenue_share_pct of net revenue.",
};

const PAYOUT: RevenuePayout = {
  payout_id: 3,
  period: {
    kind: "QUARTERLY",
    from: "2026-04-01T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
  },
  qualifying_packs: 120,
  gross_usdc: "3000.000000",
  sellback_count: 11,
  sellback_usdc: "400.000000",
  net_usdc: "2600.000000",
  revenue_share_bps: 500,
  revenue_share_pct: "5.00",
  revenue_share_usdc: "130.000000",
  fees_usdc: "0.000000",
  rip_retained_usdc: "2470.000000",
  by_product: BY_PRODUCT,
  payout_usdc: "130.000000",
  payout_micros: "130000000",
  status: "PAID",
  payout_address: "0xpayout",
  chain: "base",
  tx_hash: `0x${"f".repeat(64)}`,
  paid_at: "2026-07-05T00:00:00.000Z",
};

describe("revenue.terms", () => {
  it("reads the negotiated per-product rates", async () => {
    const fx = mockFetch([ok(TERMS)]);
    const terms = await makeClient(fx).revenue.terms();

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/terms");
    expect(terms.revenue_share_pct).toBe("5.00");
    expect(terms.instant_revenue_share_pct).toBe("1.00");
    expect(terms.payout_wallet!.address).toBe("0xpayout");
  });
});

describe("revenue.summary", () => {
  it("passes the period bounds as query params", async () => {
    const fx = mockFetch([ok(SUMMARY)]);
    const summary = await makeClient(fx).revenue.summary({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/revenue");
    expect(fx.last.url.searchParams.get("from")).toBe("2026-07-01T00:00:00.000Z");
    expect(fx.last.url.searchParams.get("to")).toBe("2026-10-01T00:00:00.000Z");
    expect(summary.revenue_share_usdc).toBe("44.499000");
    expect(summary.by_product.instant.share_bps).toBe(100);
  });

  it("sends no query at all for all-time", async () => {
    const fx = mockFetch([ok(SUMMARY)]);
    await makeClient(fx).revenue.summary();
    expect(fx.last.url.search).toBe("");
  });
});

describe("revenue.payouts", () => {
  it("pages through closed statements", async () => {
    const fx = mockFetch([
      ok({ payouts: [PAYOUT] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok(
        { payouts: [{ ...PAYOUT, payout_id: 2, status: "VOID" }] },
        { pagination: { limit: 1, offset: 1, has_more: false } },
      ),
    ]);
    const first = await makeClient(fx).revenue.payouts({ limit: 1 });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/payouts");
    expect(first.items[0]!.status).toBe("PAID");

    const second = await first.next();
    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(second!.items[0]!.status).toBe("VOID");
    expect(await second!.next()).toBeNull();
  });
});

describe("revenue.outstanding", () => {
  it("returns only the totals, not the statement rows", async () => {
    const fx = mockFetch([
      ok({
        payouts: [PAYOUT],
        outstanding_usdc: "0.000000",
        accruing: {
          since: "2026-07-01T00:00:00.000Z",
          as_of: "2026-09-01T00:00:00.000Z",
          qualifying_packs: 40,
          instant_packs: 10,
          sellback_count: 3,
          gross_usdc: "1049.900000",
          sellback_usdc: "120.000000",
          net_usdc: "929.900000",
          payout_usdc: "44.499000",
          period_closes_at: "2026-10-01T00:00:00.000Z",
        },
        total_owed_usdc: "44.499000",
      }),
    ]);
    const owed = await makeClient(fx).revenue.outstanding();

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/payouts");
    expect(fx.last.url.searchParams.get("limit")).toBe("1");
    expect(owed.total_owed_usdc).toBe("44.499000");
    expect(owed.accruing!.period_closes_at).toBe("2026-10-01T00:00:00.000Z");
    expect(owed).not.toHaveProperty("payouts");
  });
});

describe("revenue payout wallet", () => {
  it("reads the active wallet", async () => {
    const fx = mockFetch([
      ok({
        chain: "base",
        address: "0xpayout",
        is_active: true,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const wallet = await makeClient(fx).revenue.getPayoutWallet({ chain: "base" });

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/payout-wallet");
    expect(fx.last.url.searchParams.get("chain")).toBe("base");
    expect(wallet.is_active).toBe(true);
  });

  it("maps 404 payout_wallet_not_set to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "payout_wallet_not_set", "No payout wallet configured")]);
    const err = await makeClient(fx)
      .revenue.getPayoutWallet()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe("payout_wallet_not_set");
  });

  it("PUTs a new destination", async () => {
    const fx = mockFetch([
      ok({
        chain: "base",
        address: "0xnew",
        is_active: true,
        created_at: "2026-09-01T00:00:00.000Z",
      }),
    ]);
    const wallet = await makeClient(fx).revenue.setPayoutWallet({ address: "0xnew" });

    expect(fx.last.method).toBe("PUT");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/payout-wallet");
    expect(fx.last.body).toEqual({ address: "0xnew" });
    expect(wallet.address).toBe("0xnew");
  });

  it("maps 400 invalid_address to ValidationError", async () => {
    const fx = mockFetch([fail(400, "invalid_address", "not a 0x address")]);
    const err = await makeClient(fx)
      .revenue.setPayoutWallet({ address: "nope" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
  });
});
