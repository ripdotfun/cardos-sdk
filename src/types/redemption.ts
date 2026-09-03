/**
 * Physical redemption — ship the real card and burn the NFT.
 *
 * The END USER signs: `prepare()` returns unsigned calldata (the redemption
 * burn flag plus their on-chain shipping payment), they broadcast it from the
 * wallet holding the token, and `submit()` records the hash. Partners are never
 * billed for shipping; the item ships only once that shipping payment is
 * on-chain, and the token burns at dispatch.
 *
 * CardOS runs no KYC/AML on your end users — screening them is your
 * responsibility.
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

/**
 * Redemption lifecycle: `PREPARED` → `BURN_SUBMITTED` → `IN_FULFILLMENT` →
 * `COMPLETED`, or `FAILED` / `CANCELLED` / `EXPIRED`.
 */
export type RedemptionStatus =
  | "PREPARED"
  | "BURN_SUBMITTED"
  | "IN_FULFILLMENT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

/** What kind of on-chain asset is being redeemed. */
export type RedemptionItemType = "CARD" | "GRADED_CARD" | "PACKET" | "SEALED_PRODUCT";

/**
 * Who funds shipping. Always `"end_user"` — the holder pays the quoted shipping
 * on-chain, and partner-billed shipping is not offered.
 */
export type RedemptionShippingPayer = "end_user";

/** Where the physical item is sent. Validated through Shippo. */
export interface RedemptionShippingAddress {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state?: string | null;
  zip: string;
  /** ISO country code, e.g. `"US"`. */
  country: string;
  phone?: string | null;
  email?: string | null;
}

/** Cheapest live Shippo rate — snapshotted onto the redemption at prepare. */
export interface RedemptionShippingQuote {
  amount_usdc: UsdcString;
  /** e.g. `"USD"`. */
  currency: string;
  carrier: string | null;
  service: string | null;
  /** Shippo servicelevel token the warehouse exact-matches when buying the label. */
  service_token: string | null;
  estimated_days: number | null;
  rate_id: string | null;
  quoted_at: IsoDate;
}

/**
 * The end user's on-chain shipping payment: the EIP-712 quote the `payShipping`
 * call carries, echoed so you can display and verify it without decoding
 * calldata. Single-use, payer-bound, amount-locked; the signature expires with
 * the prepare (`expiration_time` matches `expires_at`).
 */
export interface RedemptionShippingPayment {
  /** The holder wallet that must fund the payment. */
  payer: Address;
  /** Address of the shipping payment processor contract. */
  processor: Address;
  total_usdc: UsdcString;
  total_micros: MicrosString;
  /** Unix seconds. */
  expiration_time: number;
  /** Identifier of the fulfillment order the payment settles. */
  provider_order_id: string;
}

/** Machine-readable call type — dispatch on this, not the description or selector. */
export type RedemptionCallKind = "burn" | "erc20-approve" | "shipping-payment";

export interface RedemptionUnsignedCall {
  to: Address;
  data: `0x${string}`;
  kind: RedemptionCallKind;
  description: string;
}

/**
 * Calldata the END USER signs and broadcasts from the wallet holding the token.
 * Keep the order: burn first (`payShipping` verifies the burn state), and send
 * the approve as its own userop under account abstraction.
 */
export interface RedemptionUnsignedCalls {
  chain_id: number;
  calls: RedemptionUnsignedCall[];
}

/** Result of `redemption.prepare()`. */
export interface RedemptionPrepareResult {
  redemption_id: number;
  status: RedemptionStatus;
  item_type: RedemptionItemType;
  token_id: string;
  shipping_quote: RedemptionShippingQuote | null;
  /** Always `"end_user"` — you are never billed for shipping. */
  shipping_payer: RedemptionShippingPayer;
  /** Present while the end user's shipping payment is still due; `null` once paid. */
  shipping_payment: RedemptionShippingPayment | null;
  /** Default 24 h. `EXPIRED` redemptions are retryable with a new idempotency key. */
  expires_at: IsoDate | null;
  /**
   * The calls to hand the end user. `null` only when re-serialising an existing
   * row that has already moved past `PREPARED`.
   */
  unsigned: RedemptionUnsignedCalls | null;
}

/** Result of `redemption.submit()` (202). */
export interface RedemptionSubmitResult {
  redemption_id: number;
  status: RedemptionStatus;
  burn_tx_hash: TxHash;
  /**
   * Present only when the shipping label was bought right here, which needs the
   * burn already confirmed on-chain AND the shipping payment landed. Absent (or
   * null) otherwise, and that is the normal case: the label is bought later and
   * the tracking number reaches you on `get()` and the `redemption.updated`
   * webhook. Never read their absence as a failure.
   */
  tracking_number?: string | null;
  tracking_url?: string | null;
  label_url?: string | null;
  carrier?: string | null;
  service?: string | null;
}

/** One redemption, as returned by `redemption.get()` / `redemption.list()`. */
export interface Redemption {
  redemption_id: number;
  /** `null` for token-first (own-gacha) redemptions. */
  purchase_id: number | null;
  token_id: string;
  item_type: RedemptionItemType;
  status: RedemptionStatus;
  burn: {
    /** Recorded burn state, e.g. `"PENDING_REDEEM"`. */
    db_status: string | null;
    /** Burn finalized — flips at physical dispatch. */
    is_burned: boolean;
    burn_type: number | null;
    /** e.g. `"REDEEM_CARD"`. */
    burn_type_label: string | null;
  };
  queue: { status: string | null };
  order: { status: string | null; tracking_number: string | null };
  burn_tx_hash: TxHash | null;
  shipping_quote: RedemptionShippingQuote | null;
  failure_reason: string | null;
  expires_at: IsoDate | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/** Supply `purchase_id` OR `token_id`. `token_id` alone is a token-first redemption. */
export interface RedemptionTarget {
  purchase_id?: number;
  /** On-chain token id. With `purchase_id`, it disambiguates a multi-item purchase. */
  token_id?: string;
  /** Disambiguates a token number that exists as more than one asset type. */
  item_type?: RedemptionItemType;
}

export interface RedemptionQuoteParams extends RedemptionTarget, RequestOverrides {
  shipping_address: RedemptionShippingAddress;
}

export interface RedemptionPrepareParams extends RedemptionTarget, RequestOverrides {
  shipping_address: RedemptionShippingAddress;
  /** Sent as `Idempotency-Key`. Generated for you when omitted. */
  idempotency_key?: string;
  /**
   * `"end_user"` is the only accepted value (and the default) — anything else
   * is 400 `invalid_shipping_payer`.
   */
  shipping_payer?: RedemptionShippingPayer;
}

export interface RedemptionSubmitParams extends RequestOverrides {
  redemption_id: number;
  /** 0x-prefixed 32-byte hash of the transaction the holder already sent. */
  tx_hash: TxHash;
}

export interface RedemptionGetParams extends RequestOverrides {
  /** Check the card's burn state live on-chain instead of the cached value. */
  verify?: boolean;
}

export interface RedemptionListParams extends OffsetPageParams, RequestOverrides {
  status?: RedemptionStatus;
}
