/**
 * `cardos.sellback` — the native combo-pool sell-back, for partners selling
 * CardOS tiers. This is the same loop a first-party rip.fun user runs, and the
 * only sell-back path on the TIER model (`cardos.buyback` is the POOL-model
 * mechanism, and a TIER key calling it gets a 403).
 *
 * Two rules the contract enforces and `quote()` pre-flights: only the ORIGINAL
 * recipient may sell (a card that changed hands never can), and only before its
 * buyback window expires. A batch is capped at 50 cards and is all-or-nothing
 * on-chain, so check every token before preparing.
 */

import type { OffsetPage } from "../pagination.js";
import type {
  SellbackListParams,
  SellbackPrepareParams,
  SellbackPrepareResult,
  SellbackQuote,
  SellbackQuoteParams,
  SellbackRecord,
  SellbackSubmitParams,
} from "../types/sellback.js";
import { Resource } from "./base.js";

export class SellbackResource extends Resource {
  /**
   * Which of a holder's cards can be sold back to the pool, and for how much.
   *
   * `POST /api/v1/mystery/sellback/quote` — scope `packs:read`.
   * Creates nothing. Check `items[].eligible` for every token before preparing:
   * the on-chain call is all-or-nothing, and `sufficient_liquidity: false` is a
   * revert you can avoid.
   *
   * Notable errors: 400 `invalid_token_ids` / `too_many_tokens` (> 50),
   * 403 `not_tier_partner` (your account sells its own inventory — use
   * `cardos.buyback`).
   */
  quote(params: SellbackQuoteParams): Promise<SellbackQuote> {
    const { overrides, rest } = this.split(params);
    return this.http.data<SellbackQuote>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/sellback/quote",
      body: rest,
    });
  }

  /**
   * The unsigned calls the HOLDER signs to sell back — CardOS never holds the
   * NFT and never broadcasts for them.
   *
   * `POST /api/v1/mystery/sellback/prepare` — scope `packs:buyback`.
   * Up to two calls, in order: a one-time `Card.setApprovalForAll` (present only
   * when `approval_needed`; the pool does `safeTransferFrom` inside the sale, so
   * without it the whole tx reverts) then `MysteryComboPool.acceptCardBuyback`.
   * Dispatch on `calls[].kind`, not the description.
   *
   * `min_total_usdc` is on-chain slippage protection: the pool re-reads the
   * oracle at execution time, so a floor equal to the quote reverts on any
   * downward drift. The default allows 1 % (`slippage_bps` 100).
   *
   * Notable errors: 409 `window_expired` / `wrong_holder` / `value_unknown` /
   * `insufficient_liquidity`.
   */
  prepare(params: SellbackPrepareParams): Promise<SellbackPrepareResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<SellbackPrepareResult>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/sellback/prepare",
      body: rest,
    });
  }

  /**
   * Record a sell-back the holder already broadcast.
   *
   * `POST /api/v1/mystery/sellback/submit` — scope `packs:buyback`.
   * The payout is decoded from the on-chain `CardSellExecuted` log, never taken
   * from your request — that number is the deduction in your net revenue.
   * CardOS indexes the same event independently; whichever lands first wins, so
   * re-submitting the same tx is always safe.
   *
   * Notable errors: 400 `tx_reverted` / `tx_unverified` (not mined, or not a
   * combo-pool sell-back), 403 `seller_mismatch`.
   */
  submit(params: SellbackSubmitParams): Promise<SellbackRecord> {
    const { overrides, rest } = this.split(params);
    return this.http.data<SellbackRecord>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/sellback/submit",
      body: rest,
    });
  }

  /**
   * Every native sell-back across your end users, newest first.
   *
   * `GET /api/v1/mystery/sellbacks` — scope `packs:read`.
   * `raw_card_count` is how many cards in the sale came from a pack whose
   * contents included a raw card — the subset that counts against the raw-card
   * revenue share.
   */
  list(params?: SellbackListParams): Promise<OffsetPage<SellbackRecord>> {
    const { overrides, rest } = this.split(params);
    return this.offsetPage<SellbackRecord>(
      { ...overrides, path: "/api/v1/mystery/sellbacks" },
      "sellbacks",
      rest,
    );
  }
}
