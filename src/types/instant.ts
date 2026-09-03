/**
 * Instant packs — a booster pack bought AND opened in one on-chain transaction.
 * There is no pack NFT to hold: Chainlink VRF picks a pre-built card bundle
 * (from a physically ripped pack) and the cards land in the recipient wallet.
 */

import type {
  Address,
  IsoDate,
  MicrosString,
  OffsetPageParams,
  RequestOverrides,
  TxHash,
  UsdcString,
} from "./common.js";

/** Lifecycle of an instant-pack purchase. */
export type InstantPurchaseStatus =
  | "PENDING"
  | "RESERVED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "FULFILLED"
  | "REFUNDED"
  | "FAILED";

/** Who paid: the end user's custodial credits, or their own wallet. */
export type InstantCustody = "CUSTODIAL" | "NON_CUSTODIAL";

/** One purchasable packet type from `GET /instant/catalog`. */
export interface InstantCatalogItem {
  /** On-chain packet type id — the handle you pass to `prepare()`. */
  packet_type_id: number;
  set_id: string;
  set_name: string;
  product_id: string;
  name: string;
  image_url: string | null;
  large_image_url: string | null;
  /** Live on-chain price in USDC micros, e.g. `"4990000"`. */
  price: MicrosString;
  /** The same price as a decimal string, e.g. `"4.990000"`. */
  price_usdc: UsdcString;
  /** Pre-built bundles left. `0` → purchases return 409 `sold_out`. */
  available_packs: number;
  /** e.g. `"pokemon"`. */
  tcg_type: string;
  /** e.g. `"ENGLISH"`. */
  language: string;
}

/** The delivered (already-opened) pack. Present only once `FULFILLED`. */
export interface InstantPack {
  unique_id: string;
  set_id: string;
  name: string;
  image_url: string | null;
  opened_at: IsoDate | null;
}

/**
 * One delivered card. Every field but `token_id` is nullable: a token the
 * catalog has not indexed yet falls back to the bare token id.
 */
export interface InstantCard {
  token_id: string;
  unique_id: string | null;
  card_id: string | null;
  name: string | null;
  card_number: string | null;
  rarity: string | null;
  is_chase: boolean | null;
  small_image_url: string | null;
  large_image_url: string | null;
  front_image_url: string | null;
  /** Raw market price of the card, as a USD decimal string. */
  value_usd: UsdcString | null;
  set_id: string | null;
}

/** An instant-pack purchase, at whatever point in its lifecycle you read it. */
export interface InstantPurchase {
  id: number;
  /** `"{partner-slug}-instant-{id}"` attribution tag. Absent when the partner has no slug. */
  memo?: string;
  status: InstantPurchaseStatus;
  custody: InstantCustody;
  packet_type_id: number;
  set_id: string | null;
  product_id: string | null;
  quantity: number;
  /** Amount charged, in USDC micros. */
  price: MicrosString;
  price_usdc: UsdcString;
  /** VRF request id, once on-chain. */
  onchain_request_id: string | null;
  transaction_hash: TxHash | null;
  /** Wallet that paid for the purchase on-chain. */
  purchaser_address: Address | null;
  /** Wallet the cards were delivered to. */
  recipient_address: Address | null;
  failure_reason: string | null;
  reserved_at: IsoDate | null;
  submitted_at: IsoDate | null;
  fulfilled_at: IsoDate | null;
  created_at: IsoDate;
  /** Present only once `FULFILLED`. */
  pack?: InstantPack | null;
  /** Present only once `FULFILLED`. */
  cards?: InstantCard[];
}

/**
 * One unsigned call from `instant.prepare()`.
 *
 * These calls carry no `kind` discriminator (unlike the redemption and
 * sell-back calls), so dispatch on array position: `calls[0]` is the USDC
 * approve and `calls[1]` the buy-and-open.
 */
export interface InstantUnsignedCall {
  to: Address;
  data: `0x${string}`;
  description: string;
}

/** Result of `instant.prepare()` — the calls the END USER signs and broadcasts. */
export interface InstantPrepareResult {
  chain_id: number;
  /** USDC contract the approve targets. */
  payment_token: Address;
  /** RipFunStore contract the buy-and-open call targets. */
  contract: Address;
  packet_type_id: number;
  price: MicrosString;
  price_usdc: UsdcString;
  /** In order: the USDC approve, then `purchaseInstantOpenFor`. */
  calls: InstantUnsignedCall[];
}

export interface InstantCatalogParams extends OffsetPageParams, RequestOverrides {
  /** Also list packet types with no bundles left (default: available only). */
  include_unavailable?: boolean;
}

export interface InstantPrepareParams extends RequestOverrides {
  packet_type_id: number;
  /** The end user's own wallet — it signs, pays, and receives the cards. */
  wallet_address: Address;
  max_price_usdc?: UsdcString;
}

/** Either identity, both, or neither — used where attribution is optional. */
export interface InstantIdentityFilter {
  external_user_id?: string;
  wallet_address?: Address;
}

export interface InstantSubmitParams extends InstantIdentityFilter, RequestOverrides {
  packet_type_id: number;
  /** Hash of the mined buy-and-open tx. Everything else is read from the receipt. */
  transaction_hash: TxHash;
  /** Optional VRF request id, for correlation. */
  request_id?: string;
}

export interface InstantListPurchasesParams
  extends OffsetPageParams,
    InstantIdentityFilter,
    RequestOverrides {
  status?: InstantPurchaseStatus;
}
