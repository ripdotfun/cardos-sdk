/**
 * `cardos.instant` — instant packs: a booster pack bought AND opened in one
 * on-chain transaction. No pack NFT to hold and open later; Chainlink VRF picks
 * a pre-built bundle from a physically ripped pack and the cards land in the
 * recipient wallet, usually within seconds and up to ~90 s.
 */

import type { OffsetPage } from "../pagination.js";
import { poll, type PollOptions } from "../polling.js";
import type {
  InstantCatalogItem,
  InstantCatalogParams,
  InstantListPurchasesParams,
  InstantPrepareParams,
  InstantPrepareResult,
  InstantPurchase,
  InstantSubmitParams,
} from "../types/instant.js";
import type { RequestOverrides } from "../types/common.js";
import { Resource } from "./base.js";

/** Instant delivery waits on Chainlink VRF — allow ~90 s, with headroom. */
const DEFAULT_DELIVERY_TIMEOUT_MS = 180_000;

export class InstantResource extends Resource {
  /**
   * The booster packs you can sell as instant packs, with live availability.
   *
   * `GET /api/v1/instant/catalog` — scope `read:catalog`.
   * By default only packet types with `available_packs > 0` are listed; pass
   * `include_unavailable` to see sold-out ones too.
   */
  catalog(params?: InstantCatalogParams): Promise<OffsetPage<InstantCatalogItem>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, include_unavailable, ...query } = rest;
    return this.offsetPage<InstantCatalogItem>(
      {
        ...overrides,
        path: "/api/v1/instant/catalog",
        // The server tests for the literal "1" or "true".
        query: { ...query, include_unavailable: include_unavailable ? "1" : undefined },
      },
      "packs",
      { limit, offset },
    );
  }

  /**
   * Status of one instant purchase, plus the delivered pack and cards once
   * `FULFILLED`.
   *
   * `GET /api/v1/instant/purchase/{purchase_id}` — scope `packs:read`.
   * 404 `not_found` when the purchase is not this partner's.
   */
  getPurchase(purchaseId: number | string, opts?: RequestOverrides): Promise<InstantPurchase> {
    return this.http.data<InstantPurchase>({
      ...(opts ?? {}),
      method: "GET",
      path: `/api/v1/instant/purchase/${encodeURIComponent(String(purchaseId))}`,
    });
  }

  /**
   * Poll {@link getPurchase} until the cards are delivered.
   *
   * Done on `FULFILLED`; throws `TerminalStateError` on `FAILED` / `REFUNDED`
   * and `PollTimeoutError` after `timeoutMs` (default 180 000 — VRF settlement
   * takes up to ~90 s). Returns the purchase, so `pack` and `cards` are right
   * there on the result.
   */
  waitForDelivery(
    purchaseId: number | string,
    pollOpts: PollOptions = {},
  ): Promise<InstantPurchase> {
    return poll<InstantPurchase>(
      {
        label: `instant purchase ${purchaseId}`,
        fetch: () => this.getPurchase(purchaseId, { signal: pollOpts.signal }),
        isDone: (p) => p.status === "FULFILLED",
        isFailed: (p) =>
          p.status === "FAILED" || p.status === "REFUNDED" ? p.status : false,
      },
      { timeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS, ...pollOpts },
    );
  }

  /**
   * Instant-pack purchase history for this partner, newest first.
   *
   * `GET /api/v1/instant/purchases` — scope `packs:read`.
   * Filter by `status`, `external_user_id` or `wallet_address`.
   * 400 `invalid_status` for a status outside the lifecycle.
   */
  listPurchases(params?: InstantListPurchasesParams): Promise<OffsetPage<InstantPurchase>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...query } = rest;
    return this.offsetPage<InstantPurchase>(
      { ...overrides, path: "/api/v1/instant/purchases", query },
      "purchases",
      { limit, offset },
    );
  }

  /**
   * Non-custodial step 1 — the unsigned approve + buy-and-open calls for the END
   * USER's own wallet to sign, pay and receive from. Creates nothing.
   *
   * `POST /api/v1/instant/purchase/prepare` — scope `packs:purchase`.
   * Send `calls[0]` (USDC approve, skippable when the allowance already covers
   * the price) then `calls[1]` (`purchaseInstantOpenFor`), then {@link submit}
   * the hash.
   *
   * Notable errors: 400 `invalid_packet_type` / `invalid_wallet_address`,
   * 409 `sold_out` / `max_price_exceeded`, 503 `instant_disabled`.
   */
  prepare(params: InstantPrepareParams): Promise<InstantPrepareResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<InstantPrepareResult>({
      ...overrides,
      method: "POST",
      path: "/api/v1/instant/purchase/prepare",
      body: rest,
    });
  }

  /**
   * Non-custodial step 2 — record the broadcast buy-and-open tx (202
   * `SUBMITTED`).
   *
   * `POST /api/v1/instant/purchase/submit` — scope `packs:purchase`.
   * The tx is verified on-chain before anything is written: the packet type,
   * price, request id and recipient come from the receipt, never from your
   * request. Re-submitting the same hash is idempotent. Delivery then runs
   * asynchronously — {@link waitForDelivery} or the `instant_purchase.*`
   * webhooks.
   *
   * Notable errors: 400 `missing_tx_hash` / `tx_unverified` / `tx_reverted` /
   * `packet_type_mismatch` / `purchaser_mismatch`, 409 `tx_already_recorded`.
   */
  submit(params: InstantSubmitParams): Promise<InstantPurchase> {
    const { overrides, rest } = this.split(params);
    return this.http.data<InstantPurchase>({
      ...overrides,
      method: "POST",
      path: "/api/v1/instant/purchase/submit",
      body: rest,
    });
  }
}
