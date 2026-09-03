import { describe, expect, it } from "vitest";
import {
  ConflictError,
  InsufficientFundsError,
  NotFoundError,
  PollTimeoutError,
  TerminalStateError,
  type CollectionItem,
  type FeedRow,
  type OnchainTierOdds,
  type Purchase,
  type Tier,
} from "../src/index.js";
import { accepted, fail, makeClient, mockFetch, ok } from "./helpers.js";

const TIER: Tier = {
  tier_id: 3,
  name: "Vault Elite",
  slug: "vault-elite",
  description: "One card from the vault.",
  variant: "card",
  game: { id: "pokemon", label: "Pokémon" },
  price_usdc: "25",
  price_display: "$25.00",
  price_micros: "25000000",
  target_ev_usdc: "21.5",
  slot_count: 1,
  active: true,
  total_purchases: 412,
  last_active_at: "2026-09-01T10:00:00.000Z",
};

const REVEALED: Purchase = {
  id: 991,
  memo: "acme-991",
  status: "FULFILLED",
  custody: "CUSTODIAL",
  tier_id: 3,
  quantity: 1,
  price: "25000000",
  price_usdc: "25.000000",
  volume_usdc: "25.000000",
  onchain_request_id: "4821",
  transaction_hash: `0x${"a".repeat(64)}`,
  purchaser_address: `0x${"1".repeat(40)}`,
  failure_reason: null,
  reserved_at: "2026-09-01T10:00:00.000Z",
  submitted_at: "2026-09-01T10:00:03.000Z",
  fulfilled_at: "2026-09-01T10:00:19.000Z",
  created_at: "2026-09-01T10:00:00.000Z",
  items: [
    {
      token_id: "77123",
      item_type: "CARD",
      category: "card",
      card_id: "swsh7-215",
      name: "Umbreon VMAX",
      image_url: "https://img.rip.fun/swsh7-215.png",
      value_usd: "412.50",
      rarity: "Secret Rare",
      card_number: "215",
      set_id: "swsh7",
    },
  ],
};

const reserved: Purchase = { ...REVEALED, status: "RESERVED", items: undefined, fulfilled_at: null };

describe("gacha.catalog", () => {
  it("GETs the catalog, forwards filters, and unwraps data.tiers", async () => {
    const fx = mockFetch([ok({ tiers: [TIER], games: [{ id: "pokemon", label: "Pokémon" }] })]);
    const tiers = await makeClient(fx).gacha.catalog({ game: "pokemon", active: true });

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/catalog");
    expect(fx.last.url.searchParams.get("game")).toBe("pokemon");
    expect(fx.last.url.searchParams.get("active")).toBe("true");
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.price_usdc).toBe("25");
  });

  it("sends no query at all when called bare", async () => {
    const fx = mockFetch([ok({ tiers: [] })]);
    await makeClient(fx).gacha.catalog();
    expect(fx.last.url.search).toBe("");
  });
});

describe("gacha.odds", () => {
  it("GETs the tier odds and keeps the on-chain shape discriminable", async () => {
    const body: OnchainTierOdds = {
      tier_id: 3,
      scope: "onchain",
      currency: "USDC",
      tier_price_usdc: "25",
      target_ev_usdc: "21.5",
      slot_count: 1,
      active: true,
      rarity_groups: [
        {
          group_id: 4,
          name: "Chase",
          tier_label: "S",
          color: "#f0f",
          min_price: "100",
          max_price: "5000",
          avg_price: "480",
          weight: "50",
          probability: 0.05,
          available_count: 122,
        },
      ],
      slots: [
        {
          slot_index: 0,
          slot_type: "CARD",
          min_value_usdc: "1",
          max_value_usdc: "5000",
          groups: [{ group_id: 4, weight: "50", probability: 0.05 }],
        },
      ],
    };
    const fx = mockFetch([ok(body)]);
    const odds = await makeClient(fx).gacha.odds(3);

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/catalog/3/odds");
    expect(odds.scope).toBe("onchain");
    if (odds.scope === "onchain") expect(odds.slots[0]!.slot_type).toBe("CARD");
  });
});

describe("gacha.feed", () => {
  const row: FeedRow = {
    token_id: "77123",
    item_type: "CARD",
    card_name: "Umbreon VMAX",
    card_image_url: "https://img.rip.fun/swsh7-215.png",
    card_price_usdc: "412.50",
    tier_id: 3,
    revealed_at: "2026-09-01T10:00:19.000Z",
    game: { id: "pokemon", label: "Pokémon" },
  };

  it("pages the recent feed and follows next()", async () => {
    const fx = mockFetch([
      ok({ items: [row] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ items: [{ ...row, token_id: "77124" }] }, {
        pagination: { limit: 1, offset: 1, has_more: false },
      }),
    ]);
    const page = await makeClient(fx).gacha.feed.recent({ limit: 1, game: "pokemon" });

    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/mystery/feed/recent");
    expect(fx.calls[0]!.url.searchParams.get("limit")).toBe("1");
    expect(fx.calls[0]!.url.searchParams.get("game")).toBe("pokemon");
    expect(fx.calls[0]!.url.searchParams.has("scope")).toBe(false);
    expect(page.items[0]!.card_price_usdc).toBe("412.50");
    expect(page.hasMore).toBe(true);

    const next = await page.next();
    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(next!.items[0]!.token_id).toBe("77124");
    expect(await next!.next()).toBeNull();
  });

  it("hits /feed/winners for winners", async () => {
    const fx = mockFetch([ok({ items: [] })]);
    await makeClient(fx).gacha.feed.winners();
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/feed/winners");
  });

  it("adds scope=mine for the partner's own pulls", async () => {
    const fx = mockFetch([ok({ items: [] })]);
    await makeClient(fx).gacha.feed.mine({ limit: 10 });
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/feed/recent");
    expect(fx.last.url.searchParams.get("scope")).toBe("mine");
  });
});

describe("gacha.purchase", () => {
  it("POSTs the identity + tier and auto-generates an Idempotency-Key", async () => {
    const fx = mockFetch([accepted(reserved)]);
    const purchase = await makeClient(fx).gacha.purchase({ tier_id: 3, external_user_id: "u_42" });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/purchase");
    expect(fx.last.body).toEqual({ tier_id: 3, external_user_id: "u_42" });
    expect(fx.last.headers["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(purchase.status).toBe("RESERVED");
    expect(purchase.custody).toBe("CUSTODIAL");
  });

  it("sends a caller-supplied key as the header, never in the body", async () => {
    const fx = mockFetch([accepted(reserved)]);
    await makeClient(fx).gacha.purchase({
      tier_id: 3,
      wallet_address: `0x${"1".repeat(40)}`,
      max_price_usdc: "26",
      idempotency_key: "buy-42-tier3",
    });

    expect(fx.last.headers["idempotency-key"]).toBe("buy-42-tier3");
    expect(fx.last.body).toEqual({
      tier_id: 3,
      wallet_address: `0x${"1".repeat(40)}`,
      max_price_usdc: "26",
    });
  });

  it("maps 402 insufficient_funds to InsufficientFundsError", async () => {
    const fx = mockFetch([fail(402, "insufficient_funds", "Balance 5.00 < price 25.00")]);
    const err = await makeClient(fx)
      .gacha.purchase({ tier_id: 3, external_user_id: "u_42" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).status).toBe(402);
    expect((err as InsufficientFundsError).code).toBe("insufficient_funds");
  });

  it("maps 409 idempotency_mismatch to ConflictError", async () => {
    const fx = mockFetch([fail(409, "idempotency_mismatch")]);
    await expect(
      makeClient(fx).gacha.purchase({ tier_id: 4, external_user_id: "u_42", idempotency_key: "k" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("gacha.getPurchase / waitForReveal", () => {
  it("GETs one purchase", async () => {
    const fx = mockFetch([ok(REVEALED)]);
    const p = await makeClient(fx).gacha.getPurchase(991);
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/purchase/991");
    expect(p.items![0]!.card_id).toBe("swsh7-215");
  });

  it("maps 404 to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "not_found", "Purchase not found")]);
    await expect(makeClient(fx).gacha.getPurchase(1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("polls until FULFILLED and resolves with the revealed items", async () => {
    const fx = mockFetch([ok({ ...reserved, status: "SUBMITTED" }), ok(REVEALED)]);
    const seen: string[] = [];
    const { items } = await makeClient(fx).gacha.waitForReveal(991, {
      intervalMs: 1,
      timeoutMs: 5_000,
      onPoll: (v) => seen.push((v as Purchase).status),
    });

    expect(fx.calls).toHaveLength(2);
    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/mystery/purchase/991");
    expect(seen).toEqual(["SUBMITTED", "FULFILLED"]);
    expect(items![0]!.name).toBe("Umbreon VMAX");
  });

  it("treats PARTIALLY_FULFILLED as done", async () => {
    const fx = mockFetch([ok({ ...REVEALED, status: "PARTIALLY_FULFILLED" })]);
    const p = await makeClient(fx).gacha.waitForReveal(991, { intervalMs: 1 });
    expect(p.status).toBe("PARTIALLY_FULFILLED");
  });

  it("throws TerminalStateError on REFUNDED, carrying the purchase", async () => {
    const refunded: Purchase = { ...reserved, status: "REFUNDED", failure_reason: "vrf_timeout" };
    const fx = mockFetch([ok(refunded)]);
    const err = (await makeClient(fx)
      .gacha.waitForReveal(991, { intervalMs: 1 })
      .catch((e: unknown) => e)) as TerminalStateError<Purchase>;

    expect(err).toBeInstanceOf(TerminalStateError);
    expect(err.state).toBe("REFUNDED");
    expect(err.value.failure_reason).toBe("vrf_timeout");
  });

  it("throws TerminalStateError on FAILED", async () => {
    const fx = mockFetch([ok({ ...reserved, status: "FAILED" })]);
    await expect(
      makeClient(fx).gacha.waitForReveal(991, { intervalMs: 1 }),
    ).rejects.toBeInstanceOf(TerminalStateError);
  });

  it("throws PollTimeoutError with the last value when it runs out of time", async () => {
    const fx = mockFetch([ok({ ...reserved, status: "SUBMITTED" })]);
    const err = (await makeClient(fx)
      .gacha.waitForReveal(991, { intervalMs: 5, timeoutMs: 1 })
      .catch((e: unknown) => e)) as PollTimeoutError<Purchase>;

    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.lastValue!.status).toBe("SUBMITTED");
    expect(fx.calls).toHaveLength(1);
  });
});

describe("gacha.listPurchases", () => {
  it("filters by status + identity and pages with next()", async () => {
    const fx = mockFetch([
      ok({ purchases: [REVEALED] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ purchases: [{ ...REVEALED, id: 992 }] }, {
        pagination: { limit: 1, offset: 1, has_more: false },
      }),
    ]);
    const page = await makeClient(fx).gacha.listPurchases({
      status: "FULFILLED",
      external_user_id: "u_42",
      limit: 1,
    });

    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/mystery/purchases");
    expect(fx.calls[0]!.url.searchParams.get("status")).toBe("FULFILLED");
    expect(fx.calls[0]!.url.searchParams.get("external_user_id")).toBe("u_42");
    expect(page.items[0]!.id).toBe(991);

    const next = await page.next();
    expect(next!.items[0]!.id).toBe(992);
    expect(next!.hasMore).toBe(false);
  });
});

describe("gacha.collection", () => {
  const item: CollectionItem = {
    token_id: "77123",
    item_type: "CARD",
    category: "card",
    card_id: "swsh7-215",
    name: "Umbreon VMAX",
    image_url: "https://img.rip.fun/swsh7-215.png",
    value_usd: "412.50",
    rarity: "Secret Rare",
    card_number: "215",
    set_id: "swsh7",
    purchase_id: 991,
    tier_id: 3,
    acquired_at: "2026-09-01T10:00:19.000Z",
    still_owned: true,
  };
  const user = { external_user_id: "u_42", wallet_address: `0x${"1".repeat(40)}` };

  it("returns a page that also carries the resolved user, and keeps it across next()", async () => {
    const fx = mockFetch([
      ok({ user, items: [item] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ user, items: [{ ...item, token_id: "77124" }] }, {
        pagination: { limit: 1, offset: 1, has_more: false },
      }),
    ]);
    const page = await makeClient(fx).gacha.collection({ external_user_id: "u_42", limit: 1 });

    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/mystery/collection");
    expect(fx.calls[0]!.url.searchParams.get("external_user_id")).toBe("u_42");
    expect(page.user.wallet_address).toBe(user.wallet_address);
    expect(page.items[0]!.still_owned).toBe(true);

    const next = await page.next();
    expect(next!.user.external_user_id).toBe("u_42");
    expect(next!.items[0]!.token_id).toBe("77124");
  });

  it("iterates every item across pages", async () => {
    const fx = mockFetch([
      ok({ user, items: [item] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ user, items: [{ ...item, token_id: "77124" }] }, {
        pagination: { limit: 1, offset: 1, has_more: false },
      }),
    ]);
    const page = await makeClient(fx).gacha.collection({ external_user_id: "u_42", limit: 1 });
    expect((await page.all()).map((i) => i.token_id)).toEqual(["77123", "77124"]);
  });
});

describe("gacha.stats", () => {
  it("GETs the partner stats", async () => {
    const fx = mockFetch([
      ok({
        partner_slug: "acme",
        currency: "USDC",
        total_purchases: 412,
        fulfilled: 400,
        refunded: 8,
        failed: 4,
        total_volume: "10300000000",
        total_volume_usdc: "10300.000000",
        by_tier: [{ tier_id: 3, pulls: 412, volume: "10300000000", volume_usdc: "10300.000000" }],
        buyback: {
          offers: 30,
          accepted: 12,
          offered_volume_usdc: "900.000000",
          accepted_volume_usdc: "410.000000",
        },
      }),
    ]);
    const stats = await makeClient(fx).gacha.stats();
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/stats");
    expect(stats.by_tier[0]!.volume_usdc).toBe("10300.000000");
  });
});

describe("gacha.prepare / submit", () => {
  it("POSTs prepare and returns the unsigned calls", async () => {
    const fx = mockFetch([
      ok({
        chain_id: 8453,
        payment_token: `0x${"2".repeat(40)}`,
        contract: `0x${"3".repeat(40)}`,
        max_price: "25000000",
        max_price_usdc: "25.000000",
        calls: [
          { to: `0x${"2".repeat(40)}`, data: "0xabc", kind: "erc20-approve", description: "Approve USDC to MysteryComboPool" },
          { to: `0x${"3".repeat(40)}`, data: "0xdef", kind: "purchase", description: "Purchase combo tier" },
        ],
      }),
    ]);
    const prep = await makeClient(fx).gacha.prepare({
      wallet_address: `0x${"1".repeat(40)}`,
      tier_id: 3,
    });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/purchase/prepare");
    expect(fx.last.body).toEqual({ wallet_address: `0x${"1".repeat(40)}`, tier_id: 3 });
    expect(fx.last.headers["idempotency-key"]).toBeUndefined();
    expect(prep.calls.map((c) => c.kind)).toEqual(["erc20-approve", "purchase"]);
  });

  it("POSTs submit with the tx hash and returns the purchase", async () => {
    const fx = mockFetch([accepted({ ...REVEALED, custody: "NON_CUSTODIAL" })]);
    const p = await makeClient(fx).gacha.submit({
      wallet_address: `0x${"1".repeat(40)}`,
      tier_id: 3,
      transaction_hash: `0x${"a".repeat(64)}`,
      request_id: "4821",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/purchase/submit");
    expect(fx.last.body).toEqual({
      wallet_address: `0x${"1".repeat(40)}`,
      tier_id: 3,
      transaction_hash: `0x${"a".repeat(64)}`,
      request_id: "4821",
    });
    expect(p.custody).toBe("NON_CUSTODIAL");
  });
});

describe("gacha.price", () => {
  it("GETs a quote by token_id", async () => {
    const fx = mockFetch([
      ok({
        card_id: "swsh7-215",
        token_id: "77123",
        item_type: "CARD",
        market_value_usdc: "412.500000",
        buyback_price_usdc: "350.625000",
        value_source: "card_raw_price",
        updated_at: "2026-09-01T09:00:00.000Z",
      }),
    ]);
    const quote = await makeClient(fx).gacha.price({ token_id: "77123" });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/price");
    expect(fx.last.url.searchParams.get("token_id")).toBe("77123");
    expect(fx.last.url.searchParams.has("card_id")).toBe(false);
    expect(quote.buyback_price_usdc).toBe("350.625000");
  });

  it("maps 404 value_unknown to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "value_unknown", "No graded market price")]);
    const err = await makeClient(fx)
      .gacha.price({ card_id: "base1-4" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe("value_unknown");
  });
});

describe("gacha.games", () => {
  it("reads data.games from the catalog endpoint", async () => {
    const fx = mockFetch([ok({ tiers: [], games: [{ id: "pokemon", label: "Pokémon" }] })]);
    const c = makeClient(fx);
    const games = await c.gacha.games();
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/catalog");
    expect(fx.last.url.search).toBe("");
    expect(games).toEqual([{ id: "pokemon", label: "Pokémon" }]);
  });
});
