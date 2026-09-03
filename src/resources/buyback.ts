/**
 * `cardos.buyback` — marketplace buyback offers, for POOL-model partners who
 * hold their OWN inventory in the pool.
 *
 * CardOS signs a priced EIP-712 offer against a token; when the holder accepts,
 * CardOS fronts the USDC and the amount lands on your bill. This is NOT the
 * native combo-pool sell-back (`cardos.sellback`) — a TIER-model key calling
 * anything here gets 403 "Not available on your plan".
 *
 * Who signs what: CardOS signs the offer. The HOLDER signs the EIP-712
 * acceptance from {@link BuybackResource.acceptPrepare}, and — separately, and
 * only once per wallet — must broadcast `nft_approval.call` themselves, because
 * `setApprovalForAll` cannot be relayed. You POST their signature back through
 * {@link BuybackResource.accept} and CardOS relays `acceptOffer`, paying the gas.
 */

import type {
  BuybackAcceptParams,
  BuybackAcceptPrepareParams,
  BuybackAcceptPrepareResult,
  BuybackAcceptResult,
  BuybackCreateParams,
  BuybackOffer,
  BuybackOfferSummary,
  BuybackOffersParams,
} from "../types/buyback.js";
import type { RequestOverrides } from "../types/common.js";
import { Resource } from "./base.js";

export class BuybackResource extends Resource {
  /**
   * Create a buyback offer straight from a token id — the primary path, and the
   * one that works whether or not the pull happened through this API (201).
   *
   * `POST /api/v1/mystery/buyback` — scope `packs:buyback`, POOL model only.
   * The offer is priced from the card's market value — a graded slab from the
   * graded market price for that exact (card, company, grade), never from the
   * raw value — and targets the token's current holder. `offer_price_usdc`
   * may only lower that price.
   *
   * Idempotent per (partner, token): an existing active offer comes back with
   * `idempotent: true` rather than being re-signed.
   *
   * Notable errors: 400 `token_required` / `price_too_high`,
   * 403 "Not available on your plan" (TIER key), 404 `token_not_found`,
   * 409 `value_unknown` (no market value to price from) / `not_eligible`
   * (burned, frozen, not whitelisted, …).
   */
  create(params: BuybackCreateParams): Promise<BuybackOffer> {
    const { overrides, rest } = this.split(params);
    return this.http.data<BuybackOffer>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/buyback",
      body: rest,
    });
  }

  /**
   * Your buyback offers on one on-chain token, across both forms — token-first
   * and purchase-linked (`purchase_id` is `null` for token-first ones).
   *
   * `GET /api/v1/mystery/buyback?token_id=…` — scope `packs:read`, POOL model
   * only. The raw token id of a graded card resolves to the GradedCard token.
   * Check `status` and `deadline` before building an accept flow around an
   * offer. 400 `token_required` when `token_id` is missing.
   */
  offers(params: BuybackOffersParams): Promise<BuybackOfferSummary[]> {
    const { overrides, rest } = this.split(params);
    return this.http
      .data<{ offers: BuybackOfferSummary[] }>({
        ...overrides,
        method: "GET",
        path: "/api/v1/mystery/buyback",
        query: { token_id: rest.token_id },
      })
      .then((d) => d.offers ?? []);
  }

  /**
   * Everything the HOLDER needs to accept the active offer gaslessly.
   *
   * `POST /api/v1/mystery/buyback/{token}/accept/prepare` — scope `packs:read`,
   * POOL model only. Returns the EIP-712 `typed_data` for
   * `eth_signTypedData_v4`, whether the one-time NFT approval is still owed
   * (with the ready-to-send `nft_approval.call` if so), whether a pending burn
   * has frozen transfers, and a `self_submit.call` for holders who would rather
   * send `acceptOffer` on their own gas.
   *
   * `receiver` is read from the LIVE on-chain owner, not the offer's stored
   * `target`, so a card that changed hands since signing prepares for its
   * current holder.
   *
   * Notable errors: 404 `no_active_offer`.
   */
  acceptPrepare(
    token: string,
    params?: BuybackAcceptPrepareParams,
  ): Promise<BuybackAcceptPrepareResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<BuybackAcceptPrepareResult>({
      ...overrides,
      method: "POST",
      path: `/api/v1/mystery/buyback/${encodeURIComponent(token)}/accept/prepare`,
      body: rest,
    });
  }

  /**
   * Relay the holder's signed acceptance on-chain — CardOS pays the gas.
   *
   * `POST /api/v1/mystery/buyback/{token}/accept` — scope `packs:buyback`,
   * POOL model only. Submit the signature the holder produced over
   * {@link acceptPrepare}'s `typed_data`. The card transfers to the pool signer,
   * the holder is paid in USDC, and the fronted amount lands on your bill.
   * `status` comes back `"submitted"`; settlement then flows through the
   * `buyback.*` webhooks.
   *
   * Notable errors: 400 `invalid_receiver_signature`, 409
   * `nft_approval_missing` (`details.nft_approval.call` carries the transaction
   * the holder must send first) / `receiver_signature_mismatch` /
   * `accept_simulation_failed`, 503 `relayer_disabled`.
   */
  accept(token: string, params: BuybackAcceptParams): Promise<BuybackAcceptResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<BuybackAcceptResult>({
      ...overrides,
      method: "POST",
      path: `/api/v1/mystery/buyback/${encodeURIComponent(token)}/accept`,
      body: rest,
    });
  }
}
