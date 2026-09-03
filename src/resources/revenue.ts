/**
 * `cardos.revenue` — what you earn, what you are owed, and where it is sent.
 *
 * On the TIER model there is no per-item receivable: CardOS owns the inventory
 * and funds the buyback float, and you earn a share of net revenue
 * (`gross − sell backs − fees`) at your negotiated per-product rate. Rates are
 * readable with your own key because they are negotiated and can change; a
 * change applies to periods closing from then on, so nothing already settled is
 * ever restated.
 */

import type { OffsetPage } from "../pagination.js";
import type { RequestOverrides } from "../types/common.js";
import type {
  PayoutWallet,
  PayoutWalletGetParams,
  PayoutWalletSetParams,
  RevenueOutstanding,
  RevenuePayout,
  RevenuePayoutsParams,
  RevenueSummary,
  RevenueSummaryParams,
  RevenueTerms,
} from "../types/revenue.js";
import { Resource } from "./base.js";

export class RevenueResource extends Resource {
  /**
   * Your current commercial terms: rates, plan, payout schedule and wallet.
   *
   * `GET /api/v1/mystery/terms` — scope `packs:read`.
   * Combo tiers and instant packs carry separate rates
   * (`revenue_share_pct` / `instant_revenue_share_pct`), and
   * `payout_schedule` is `QUARTERLY` unless you have agreed otherwise.
   */
  terms(opts?: RequestOverrides): Promise<RevenueTerms> {
    return this.http.data<RevenueTerms>({
      ...(opts ?? {}),
      method: "GET",
      path: "/api/v1/mystery/terms",
    });
  }

  /**
   * Gross, sell-backs, net and your share for a period.
   *
   * `GET /api/v1/mystery/revenue` — scope `packs:read`.
   * `to` is exclusive; omit both bounds for all-time. Gross counts what your
   * end users paid for QUALIFYING packs (those whose revealed contents included
   * a raw card), across `SUBMITTED` / `FULFILLED` / `PARTIALLY_FULFILLED` and
   * excluding `REFUNDED` / `FAILED`. `revenue_share_usdc` is what YOU earn;
   * `rip_retained_usdc` is the remainder, so the figures reconcile to net.
   *
   * A period where sell-backs outrun sales earns nothing rather than clawing
   * back against the next one.
   */
  summary(params?: RevenueSummaryParams): Promise<RevenueSummary> {
    const { overrides, rest } = this.split(params);
    return this.http.data<RevenueSummary>({
      ...overrides,
      method: "GET",
      path: "/api/v1/mystery/revenue",
      query: { from: rest.from, to: rest.to },
    });
  }

  /**
   * One statement per closed period, newest first.
   *
   * `GET /api/v1/mystery/payouts` — scope `packs:read`.
   * Closing a period freezes its figures AND its rates, so a statement is a
   * permanent record. `status` is `PENDING` (closed, awaiting payment), `PAID`
   * (`tx_hash` set), `FAILED`, or `VOID` (settled off the on-chain rail).
   *
   * The same endpoint also returns the totals owed; read those with
   * {@link outstanding}, which keeps this method a plain page of statements.
   */
  payouts(params?: RevenuePayoutsParams): Promise<OffsetPage<RevenuePayout>> {
    const { overrides, rest } = this.split(params);
    return this.offsetPage<RevenuePayout>(
      { ...overrides, path: "/api/v1/mystery/payouts" },
      "payouts",
      rest,
    );
  }

  /**
   * Everything owed right now: the unpaid statements plus your live share of
   * activity no statement covers yet.
   *
   * `GET /api/v1/mystery/payouts` — scope `packs:read`. The same call as
   * {@link payouts}, reading the totals beside the rows: without `accruing`,
   * your first period reads zero until it closes, even while every pull is
   * earning. `accruing` is `null` on the POOL model.
   */
  outstanding(opts?: RequestOverrides): Promise<RevenueOutstanding> {
    return this.http
      .data<RevenueOutstanding & { payouts: RevenuePayout[] }>({
        ...(opts ?? {}),
        method: "GET",
        path: "/api/v1/mystery/payouts",
        query: { limit: 1 },
      })
      .then(({ outstanding_usdc, accruing, total_owed_usdc }) => ({
        outstanding_usdc,
        accruing,
        total_owed_usdc,
      }));
  }

  /**
   * The address your revenue share is currently paid to.
   *
   * `GET /api/v1/mystery/payout-wallet` — scope `payout:manage`, which is
   * EXCLUSIVE: a partner-level `admin` scope does not satisfy it, because this
   * pair of endpoints is where your money goes.
   *
   * 404 `payout_wallet_not_set` when none has been set yet.
   */
  getPayoutWallet(params?: PayoutWalletGetParams): Promise<PayoutWallet> {
    const { overrides, rest } = this.split(params);
    return this.http.data<PayoutWallet>({
      ...overrides,
      method: "GET",
      path: "/api/v1/mystery/payout-wallet",
      query: { chain: rest.chain },
    });
  }

  /**
   * Point payouts at a new address.
   *
   * `PUT /api/v1/mystery/payout-wallet` — scope `payout:manage` (exclusive).
   * Setting a wallet deactivates the previous one in the same transaction, and
   * the old rows are kept as an audit trail of every destination your money has
   * been sent to.
   *
   * Notable errors: 400 `invalid_address` (not a 0x-prefixed 20-byte address).
   */
  setPayoutWallet(params: PayoutWalletSetParams): Promise<PayoutWallet> {
    const { overrides, rest } = this.split(params);
    return this.http.data<PayoutWallet>({
      ...overrides,
      method: "PUT",
      path: "/api/v1/mystery/payout-wallet",
      body: rest,
    });
  }
}
