import { describe, expect, it } from "vitest";
import { PollTimeoutError, TerminalStateError } from "../src/index.js";
import type { InstantPurchase } from "../src/index.js";
import { accepted, makeClient, mockFetch, ok } from "./helpers.js";

const CATALOG_ITEM = {
  packet_type_id: 42,
  set_id: "sv8pt5",
  set_name: "Prismatic Evolutions",
  product_id: "sv8pt5-booster",
  name: "Prismatic Evolutions Booster Pack",
  image_url: "https://img.rip.fun/sv8pt5.png",
  large_image_url: null,
  price: "4990000",
  price_usdc: "4.990000",
  available_packs: 137,
  tcg_type: "pokemon",
  language: "ENGLISH",
};

function purchase(over: Partial<InstantPurchase> = {}): InstantPurchase {
  return {
    id: 900,
    memo: "acme-instant-900",
    status: "RESERVED",
    custody: "CUSTODIAL",
    packet_type_id: 42,
    set_id: "sv8pt5",
    product_id: "sv8pt5-booster",
    quantity: 1,
    price: "4990000",
    price_usdc: "4.990000",
    onchain_request_id: null,
    transaction_hash: null,
    purchaser_address: null,
    recipient_address: null,
    failure_reason: null,
    reserved_at: "2026-09-01T10:00:00.000Z",
    submitted_at: null,
    fulfilled_at: null,
    created_at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

describe("instant.catalog", () => {
  it("lists packs, mapping include_unavailable to the literal 1", async () => {
    const fx = mockFetch([
      ok({ packs: [CATALOG_ITEM] }, { pagination: { limit: 2, offset: 0, has_more: false } }),
    ]);
    const page = await makeClient(fx).instant.catalog({ include_unavailable: true, limit: 2 });

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/instant/catalog");
    expect(fx.last.url.searchParams.get("include_unavailable")).toBe("1");
    expect(fx.last.url.searchParams.get("limit")).toBe("2");
    expect(page.items[0]!.packet_type_id).toBe(42);
    expect(page.items[0]!.price_usdc).toBe("4.990000");
    expect(page.hasMore).toBe(false);
  });

  it("omits include_unavailable entirely when not asked for", async () => {
    const fx = mockFetch([ok({ packs: [] })]);
    await makeClient(fx).instant.catalog();
    expect(fx.last.url.search).toBe("");
  });

  it("walks to the next page", async () => {
    const fx = mockFetch([
      ok({ packs: [CATALOG_ITEM] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok(
        { packs: [{ ...CATALOG_ITEM, packet_type_id: 43 }] },
        { pagination: { limit: 1, offset: 1, has_more: false } },
      ),
    ]);
    const first = await makeClient(fx).instant.catalog({ limit: 1 });
    const second = await first.next();

    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(second!.items[0]!.packet_type_id).toBe(43);
    expect(await second!.next()).toBeNull();
  });
});

describe("instant.getPurchase / waitForDelivery", () => {
  it("reads one purchase by id", async () => {
    const fx = mockFetch([ok(purchase({ status: "FULFILLED" }))]);
    const p = await makeClient(fx).instant.getPurchase(900);
    expect(fx.last.url.pathname).toBe("/api/v1/instant/purchase/900");
    expect(p.status).toBe("FULFILLED");
  });

  it("polls until FULFILLED and hands back the cards", async () => {
    const fx = mockFetch([
      ok(purchase({ status: "SUBMITTED" })),
      ok(
        purchase({
          status: "FULFILLED",
          fulfilled_at: "2026-09-01T10:01:00.000Z",
          pack: {
            unique_id: "pk_1",
            set_id: "sv8pt5",
            name: "Prismatic Evolutions Booster Pack",
            image_url: null,
            opened_at: "2026-09-01T10:01:00.000Z",
          },
          cards: [
            {
              token_id: "10231",
              unique_id: "c_1",
              card_id: "sv8pt5-160",
              name: "Umbreon VMAX",
              card_number: "160",
              rarity: "Secret Rare",
              is_chase: true,
              small_image_url: null,
              large_image_url: null,
              front_image_url: null,
              value_usd: "412.50",
              set_id: "sv8pt5",
            },
          ],
        }),
      ),
    ]);
    const p = await makeClient(fx).instant.waitForDelivery(900, {
      intervalMs: 1,
      maxIntervalMs: 1,
      timeoutMs: 500,
    });

    expect(fx.calls).toHaveLength(2);
    expect(p.cards?.[0]!.name).toBe("Umbreon VMAX");
    expect(p.pack?.unique_id).toBe("pk_1");
  });

  it("throws TerminalStateError on REFUNDED", async () => {
    const fx = mockFetch([ok(purchase({ status: "REFUNDED", failure_reason: "vrf_timeout" }))]);
    const err = await makeClient(fx)
      .instant.waitForDelivery(900, { intervalMs: 1, timeoutMs: 500 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TerminalStateError);
    expect((err as TerminalStateError).state).toBe("REFUNDED");
  });

  it("throws PollTimeoutError when it never settles", async () => {
    const fx = mockFetch([ok(purchase({ status: "SUBMITTING" }))]);
    const err = await makeClient(fx)
      .instant.waitForDelivery(900, { intervalMs: 5, timeoutMs: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(fx.calls).toHaveLength(1);
  });
});

describe("instant non-custodial flow", () => {
  it("prepares unsigned calls for the user's own wallet", async () => {
    const fx = mockFetch([
      ok({
        chain_id: 8453,
        payment_token: "0xusdc",
        contract: "0xstore",
        packet_type_id: 42,
        price: "4990000",
        price_usdc: "4.990000",
        calls: [
          { to: "0xusdc", data: "0x01", description: "Approve USDC to RipFunStore" },
          { to: "0xstore", data: "0x02", description: "Purchase instant pack (buy + open in one tx)" },
        ],
      }),
    ]);
    const prepared = await makeClient(fx).instant.prepare({
      packet_type_id: 42,
      wallet_address: "0xholder",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/instant/purchase/prepare");
    expect(fx.last.body).toEqual({ packet_type_id: 42, wallet_address: "0xholder" });
    expect(prepared.calls).toHaveLength(2);
    expect(prepared.chain_id).toBe(8453);
  });

  it("submits a broadcast tx", async () => {
    const fx = mockFetch([
      accepted(purchase({ status: "SUBMITTED", custody: "NON_CUSTODIAL" })),
    ]);
    const p = await makeClient(fx).instant.submit({
      packet_type_id: 42,
      transaction_hash: `0x${"1".repeat(64)}`,
      wallet_address: "0xholder",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/instant/purchase/submit");
    expect(fx.last.body).toEqual({
      packet_type_id: 42,
      transaction_hash: `0x${"1".repeat(64)}`,
      wallet_address: "0xholder",
    });
    expect(p.custody).toBe("NON_CUSTODIAL");
  });
});

describe("instant.listPurchases", () => {
  it("filters by status and identity", async () => {
    const fx = mockFetch([
      ok({ purchases: [purchase()] }, { pagination: { limit: 50, offset: 0, has_more: false } }),
    ]);
    const page = await makeClient(fx).instant.listPurchases({
      status: "FULFILLED",
      external_user_id: "u_1",
      limit: 50,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/instant/purchases");
    expect(fx.last.url.searchParams.get("status")).toBe("FULFILLED");
    expect(fx.last.url.searchParams.get("external_user_id")).toBe("u_1");
    expect(page.items).toHaveLength(1);
  });
});
