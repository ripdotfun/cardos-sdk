import { describe, expect, it } from "vitest";
import {
  InsufficientFundsError,
  PermissionError,
  ValidationError,
  type Deposit,
  type LedgerEntry,
  type WalletBalance,
} from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

const WALLET = `0x${"1".repeat(40)}`;

const BALANCE: WalletBalance = {
  end_user: { id: 7, external_user_id: "u_42", wallet_address: WALLET },
  wallet: {
    currency: "USDC",
    available: "75000000",
    reserved: "25000000",
    balance: "100000000",
    available_usdc: "75.000000",
    reserved_usdc: "25.000000",
    balance_usdc: "100.000000",
  },
};

const ENTRY: LedgerEntry = {
  id: 5001,
  entry_type: "HOLD",
  amount: "-25000000",
  amount_usdc: "-25.000000",
  balance_after: "100000000",
  reserved_after: "25000000",
  source: "purchase",
  source_id: "991",
  description: "Hold for purchase 991",
  created_at: "2026-09-01T10:00:00.000Z",
};

const DEPOSIT: Deposit = {
  id: 300,
  chain_in: "base",
  token_in: "USDC",
  amount: "100.00",
  tx_hash: `0x${"b".repeat(64)}`,
  status: "CONFIRMED",
  expected_output: "100.00",
  created_at: "2026-08-30T08:00:00.000Z",
  confirmed_at: "2026-08-30T08:01:00.000Z",
};

describe("wallet.balance", () => {
  it("GETs /api/v1/wallet/balance with the identity in the query", async () => {
    const fx = mockFetch([ok(BALANCE)]);
    const res = await makeClient(fx).wallet.balance({ external_user_id: "u_42" });

    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/wallet/balance");
    expect(fx.last.url.searchParams.get("external_user_id")).toBe("u_42");
    expect(fx.last.headers["x-api-key"]).toBe("rip_v1_test");
    expect(res.wallet.available).toBe("75000000");
    expect(res.end_user.wallet_address).toBe(WALLET);
  });

  it("accepts a wallet address as the identity", async () => {
    const fx = mockFetch([ok(BALANCE)]);
    await makeClient(fx).wallet.balance({ wallet_address: WALLET });
    expect(fx.last.url.searchParams.get("wallet_address")).toBe(WALLET);
    expect(fx.last.url.searchParams.has("external_user_id")).toBe(false);
  });

  it("maps 400 missing_user_identifier to ValidationError", async () => {
    const fx = mockFetch([fail(400, "missing_user_identifier", "external_user_id required")]);
    const err = await makeClient(fx)
      .wallet.balance({ external_user_id: "" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe("missing_user_identifier");
  });

  it("maps 402 insufficient_funds to InsufficientFundsError", async () => {
    const fx = mockFetch([fail(402, "insufficient_funds", "Balance too low")]);
    await expect(
      makeClient(fx).wallet.balance({ external_user_id: "u_42" }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe("wallet.ledger", () => {
  it("pages the ledger and follows next()", async () => {
    const fx = mockFetch([
      ok({ entries: [ENTRY] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ entries: [{ ...ENTRY, id: 5002, entry_type: "HOLD_SETTLE" }] }, {
        pagination: { limit: 1, offset: 1, has_more: false },
      }),
    ]);
    const page = await makeClient(fx).wallet.ledger({ external_user_id: "u_42", limit: 1 });

    expect(fx.calls[0]!.url.pathname).toBe("/api/v1/wallet/ledger");
    expect(fx.calls[0]!.url.searchParams.get("limit")).toBe("1");
    expect(fx.calls[0]!.url.searchParams.get("external_user_id")).toBe("u_42");
    expect(page.items[0]!.amount_usdc).toBe("-25.000000");
    expect(page.hasMore).toBe(true);

    const next = await page.next();
    expect(fx.calls[1]!.url.searchParams.get("offset")).toBe("1");
    expect(next!.items[0]!.entry_type).toBe("HOLD_SETTLE");
    expect(await next!.next()).toBeNull();
  });
});

describe("wallet.deposits", () => {
  it("exposes wallet_id and linked_internal_user beside the rows", async () => {
    const fx = mockFetch([
      ok(
        { wallet_id: 7, linked_internal_user: true, deposits: [DEPOSIT] },
        { pagination: { limit: 50, offset: 0, has_more: false } },
      ),
    ]);
    const page = await makeClient(fx).wallet.deposits({ wallet_address: WALLET });

    expect(fx.last.url.pathname).toBe("/api/v1/wallet/deposits");
    expect(page.wallet_id).toBe(7);
    expect(page.linked_internal_user).toBe(true);
    expect(page.items[0]!.status).toBe("CONFIRMED");
    expect(await page.next()).toBeNull();
  });

  it("keeps the wallet flags across next()", async () => {
    const fx = mockFetch([
      ok(
        { wallet_id: 7, linked_internal_user: true, deposits: [DEPOSIT] },
        { pagination: { limit: 1, offset: 0, has_more: true } },
      ),
      ok(
        { wallet_id: 7, linked_internal_user: true, deposits: [{ ...DEPOSIT, id: 301 }] },
        { pagination: { limit: 1, offset: 1, has_more: false } },
      ),
    ]);
    const next = await (
      await makeClient(fx).wallet.deposits({ external_user_id: "u_42", limit: 1 })
    ).next();

    expect(next!.linked_internal_user).toBe(true);
    expect(next!.items[0]!.id).toBe(301);
  });

  it("reports an unlinked end user rather than a bare empty list", async () => {
    const fx = mockFetch([
      ok(
        { wallet_id: 7, linked_internal_user: false, deposits: [] },
        { pagination: { limit: 50, offset: 0, has_more: false } },
      ),
    ]);
    const page = await makeClient(fx).wallet.deposits({ external_user_id: "u_42" });
    expect(page.items).toEqual([]);
    expect(page.linked_internal_user).toBe(false);
  });
});

describe("wallet.depositAddress", () => {
  it("POSTs the identity in the body and returns the address", async () => {
    const fx = mockFetch([
      ok({ chain: "base", address: `0x${"7".repeat(40)}`, currency: "USDC", dedicated: true }),
    ]);
    const addr = await makeClient(fx).wallet.depositAddress({ external_user_id: "u_42" });

    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/wallet/deposit-address");
    expect(fx.last.url.search).toBe("");
    expect(fx.last.body).toEqual({ external_user_id: "u_42" });
    expect(addr.dedicated).toBe(true);
    expect(addr.note).toBeUndefined();
  });

  it("surfaces the shared-address note", async () => {
    const fx = mockFetch([
      ok({
        chain: "base",
        address: `0x${"7".repeat(40)}`,
        currency: "USDC",
        dedicated: false,
        note: "Shared deposit address.",
      }),
    ]);
    const addr = await makeClient(fx).wallet.depositAddress({ wallet_address: WALLET });
    expect(addr.dedicated).toBe(false);
    expect(addr.note).toContain("Shared");
  });

  it("maps 403 to PermissionError when the key lacks wallet:deposit", async () => {
    const fx = mockFetch([fail(403, "Insufficient permissions", "Insufficient permissions")]);
    await expect(
      makeClient(fx).wallet.depositAddress({ external_user_id: "u_42" }),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});
