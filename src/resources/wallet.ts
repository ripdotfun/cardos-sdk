/**
 * `cardos.wallet` — the end user's custodial USDC credits.
 *
 * These are the balances custodial `cardos.gacha.purchase()` spends from: top
 * one up at {@link WalletResource.depositAddress}, watch it at
 * {@link WalletResource.balance}, and audit every movement in
 * {@link WalletResource.ledger}.
 *
 * Note the base path — these live at `/api/v1/wallet/*`, not under
 * `/api/v1/mystery`. Every call resolves an end user from
 * `external_user_id` and/or `wallet_address`; at least one is required.
 */

import type { OffsetPage } from "../pagination.js";
import type { Envelope, OffsetPageParams, RequestOverrides, UserIdentity } from "../types/common.js";
import {
  DepositPage,
  type Deposit,
  type DepositAddress,
  type LedgerEntry,
  type WalletBalance,
} from "../types/wallet.js";
import { Resource } from "./base.js";

const BASE = "/api/v1/wallet";

/** Identity-only params: `external_user_id` and/or `wallet_address`. */
export type WalletIdentityParams = RequestOverrides & UserIdentity;

/** Identity plus offset pagination. */
export type WalletListParams = RequestOverrides & OffsetPageParams & UserIdentity;

export class WalletResource extends Resource {
  /**
   * One end user's credit balance: `available` (what a new purchase can
   * reserve), `reserved` (held by in-flight purchases, released on refund) and
   * `balance` (the sum), each as USDC micros with a decimal twin.
   *
   * `GET /api/v1/wallet/balance` · scope `wallet:read`.
   *
   * Errors: `400 missing_user_identifier` (neither identifier given).
   */
  async balance(params: WalletIdentityParams): Promise<WalletBalance> {
    const { overrides, rest } = this.split(params);
    return this.http.data<WalletBalance>({
      ...overrides,
      method: "GET",
      path: `${BASE}/balance`,
      query: { ...rest },
    });
  }

  /**
   * The wallet's full audit trail, newest first: deposits credited, purchase
   * reserves, settlements, refunds and adjustments, each with the running
   * balance after it and a `source` / `source_id` tying it back to what caused
   * it (e.g. `purchase:123`).
   *
   * `GET /api/v1/wallet/ledger` · scope `wallet:read`.
   *
   * Errors: `400 missing_user_identifier`.
   */
  async ledger(params: WalletListParams): Promise<OffsetPage<LedgerEntry>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...identity } = rest;
    return this.offsetPage<LedgerEntry>(
      { ...overrides, path: `${BASE}/ledger`, query: { ...identity } },
      "entries",
      { limit, offset },
    );
  }

  /**
   * On-chain deposits CardOS has seen for this end user: source chain and
   * token, amount, tx hash and confirmation state.
   *
   * `GET /api/v1/wallet/deposits` · scope `wallet:read`.
   *
   * Returns a {@link DepositPage} — an `OffsetPage<Deposit>` that also carries
   * `linked_internal_user`. Check it before reading an empty page as "no
   * deposits": `linked_internal_user: false` means the end user has no linked
   * deposit identity yet, and the rows are empty for that reason.
   * `next()` returns a `DepositPage` too.
   *
   * Prefer the `deposit.credited` webhook for live updates and use this for
   * reconciliation.
   *
   * Errors: `400 missing_user_identifier`.
   */
  async deposits(params: WalletListParams): Promise<DepositPage> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...identity } = rest;

    const fetchAt = async (at: number | undefined): Promise<DepositPage> => {
      const res = await this.http.raw<
        Envelope<{ wallet_id: number; linked_internal_user: boolean; deposits: Deposit[] }>
      >({
        ...overrides,
        method: "GET",
        path: `${BASE}/deposits`,
        query: { ...identity, limit, offset: at },
      });
      const data = res.body.data;
      const items = data?.deposits ?? [];
      return new DepositPage(
        data?.wallet_id ?? 0,
        data?.linked_internal_user ?? false,
        items,
        res.body.pagination ?? { limit: limit ?? items.length, offset: at ?? 0, has_more: false },
        fetchAt,
      );
    };

    return fetchAt(offset);
  }

  /**
   * The USDC address (on Base) an end user sends funds to in order to fund
   * custodial purchases.
   *
   * `POST /api/v1/wallet/deposit-address` · scope `wallet:deposit` (a separate
   * scope — a plain `wallet:read` key cannot call this).
   *
   * `dedicated: true` is a per-end-user address, credited automatically.
   * `dedicated: false` is the shared fallback address: attribute those deposits
   * following the `note` the response carries.
   *
   * Errors: `400 missing_user_identifier`, `403 Insufficient permissions` (key
   * lacks `wallet:deposit`).
   */
  async depositAddress(params: WalletIdentityParams): Promise<DepositAddress> {
    const { overrides, rest } = this.split(params);
    return this.http.data<DepositAddress>({
      ...overrides,
      method: "POST",
      path: `${BASE}/deposit-address`,
      body: { ...rest },
    });
  }
}
