import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/index.js";
import type { BuybackOffer, BuybackOfferSummary } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

const OFFER: BuybackOffer = {
  offer_signature: `0x${"c".repeat(130)}`,
  token_id: "10231",
  item_type: "CARD",
  contract_address: "0xcard",
  requester: "0xsigner",
  target: "0xholder",
  chain_id: 8453,
  deadline: "2026-09-08T00:00:00.000Z",
  price: "17000000",
  price_usdc: "17.000000",
  seller_receives_usdc: "16.575000",
  marketplace_fee_usdc: "0.425000",
  offer_id: 501,
  value_usdc: "20.000000",
  value_source: "card_raw_price",
  note: "Offer created.",
};

const SUMMARY: BuybackOfferSummary = {
  offer_id: 501,
  signature: `0x${"c".repeat(130)}`,
  token_id: "10231",
  purchase_id: null,
  status: "active",
  price_usdc: "17.000000",
  seller_receives_usdc: "16.575000",
  deadline: "2026-09-08T00:00:00.000Z",
  accepted_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
};

describe("buyback.create", () => {
  it("POSTs a token-first offer and surfaces the value it was priced from", async () => {
    const fx = mockFetch([{ status: 201, body: { success: true, data: OFFER } }]);
    const offer = await makeClient(fx).buyback.create({
      token_id: "10231",
      item_type: "GRADED_CARD",
    });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback");
    expect(fx.last.body).toEqual({ token_id: "10231", item_type: "GRADED_CARD" });
    expect(offer.value_source).toBe("card_raw_price");
    expect(offer.seller_receives_usdc).toBe("16.575000");
  });

  it("maps 409 value_unknown to ConflictError", async () => {
    const fx = mockFetch([fail(409, "value_unknown", "No market value to price the offer from")]);
    const err = await makeClient(fx)
      .buyback.create({ token_id: "10231" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe("value_unknown");
  });

  it("maps 404 token_not_found to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "token_not_found")]);
    const err = await makeClient(fx)
      .buyback.create({ token_id: "nope" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });
});

describe("buyback.createForPurchase", () => {
  it("puts the id in the path and the disambiguator in the body", async () => {
    const fx = mockFetch([
      { status: 201, body: { success: true, data: { ...OFFER, idempotent: true } } },
    ]);
    const offer = await makeClient(fx).buyback.createForPurchase(1234, {
      token_id: "10231",
      offer_price_usdc: "15.000000",
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback/1234");
    expect(fx.last.body).toEqual({ token_id: "10231", offer_price_usdc: "15.000000" });
    expect(offer.idempotent).toBe(true);
  });

  it("sends an empty body when no options are passed", async () => {
    const fx = mockFetch([{ status: 201, body: { success: true, data: OFFER } }]);
    await makeClient(fx).buyback.createForPurchase("10231");
    expect(fx.last.body).toEqual({});
  });
});

describe("buyback.offers / get", () => {
  it("queries by token_id and unwraps the offers array", async () => {
    const fx = mockFetch([ok({ offers: [SUMMARY] })]);
    const offers = await makeClient(fx).buyback.offers({ token_id: "10231" });

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback");
    expect(fx.last.url.searchParams.get("token_id")).toBe("10231");
    expect(offers).toHaveLength(1);
    expect(offers[0]!.purchase_id).toBeNull();
  });

  it("reads offers by purchase id or token id from the path", async () => {
    const fx = mockFetch([ok({ offers: [] })]);
    const offers = await makeClient(fx).buyback.get(1234);
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback/1234");
    expect(offers).toEqual([]);
  });
});

describe("buyback accept flow", () => {
  it("prepares the typed data plus the approval and self-submit calls", async () => {
    const fx = mockFetch([
      ok({
        offer_id: 501,
        receiver: "0xliveholder",
        deadline: "2026-09-08T00:00:00.000Z",
        price_usdc: "17.000000",
        seller_receives_usdc: "16.575000",
        nft_approval: {
          approved: false,
          holder_owns_token: true,
          call: { to: "0xcard", data: "0x01", value: "0" },
        },
        transfer_frozen: { frozen: false, burn_type: null, cancel_call: null },
        self_submit: { call: { to: "0xmarket", data: "0x02", value: "0" } },
        typed_data: {
          domain: { name: "RipFun", version: "1", chainId: 8453, verifyingContract: "0xmarket" },
          types: { OfferRequest: [{ name: "tokenId", type: "uint256" }] },
          primaryType: "OfferRequest",
          message: {
            tokenContractAddress: "0xcard",
            tokenId: "10231",
            price: "17000000",
            acceptedCurrency: "0xusdc",
            deadline: "1788000000",
            requester: "0xsigner",
            chainId: "8453",
            minSellerAmount: "16575000",
          },
        },
        note: "Have the holder sign this.",
      }),
    ]);
    const prepared = await makeClient(fx).buyback.acceptPrepare("10231", {
      item_type: "CARD",
    });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback/10231/accept/prepare");
    expect(fx.last.body).toEqual({ item_type: "CARD" });
    expect(prepared.receiver).toBe("0xliveholder");
    expect(prepared.nft_approval.approved).toBe(false);
    expect(prepared.typed_data.primaryType).toBe("OfferRequest");
  });

  it("relays the holder's signature", async () => {
    const fx = mockFetch([
      ok({
        offer_id: 501,
        token_id: "10231",
        transaction_hash: `0x${"d".repeat(64)}`,
        receiver: "0xliveholder",
        requester: "0xsigner",
        price_usdc: "17.000000",
        seller_receives_usdc: "16.575000",
        status: "submitted",
        note: "acceptOffer relayed on-chain.",
      }),
    ]);
    const result = await makeClient(fx).buyback.accept("10231", {
      receiver_signature: `0x${"e".repeat(130)}`,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/mystery/buyback/10231/accept");
    expect(fx.last.body).toEqual({ receiver_signature: `0x${"e".repeat(130)}` });
    expect(result.status).toBe("submitted");
  });

  it("maps 409 nft_approval_missing to ConflictError", async () => {
    const fx = mockFetch([
      fail(409, "nft_approval_missing", "setApprovalForAll never sent", {
        details: { nft_approval: { call: { to: "0xcard", data: "0x01", value: "0" } } },
      }),
    ]);
    const err = await makeClient(fx)
      .buyback.accept("10231", { receiver_signature: "0x00" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toBeTruthy();
  });
});
