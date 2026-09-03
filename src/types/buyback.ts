/**
 * Marketplace buyback offers (POOL-model partners — you hold your OWN inventory
 * in the pool). A different mechanism from the native `/sellback/*` family: here
 * CardOS signs a priced EIP-712 offer against a token, and when the holder
 * accepts, CardOS fronts the USDC and the amount lands on your bill.
 *
 * A TIER-model key calling any of these gets 403 "Not available on your plan".
 */

import type {
  Address,
  IsoDate,
  MicrosString,
  RequestOverrides,
  TxHash,
  UsdcString,
} from "./common.js";

/** Disambiguates a numeric token id that exists as both a raw and a graded card. */
export type BuybackItemType = "CARD" | "GRADED_CARD";

/** Where the value the offer was priced from came from. */
export type BuybackValueSource =
  | "card_raw_price"
  | "buyback_oracle"
  | "graded_market_price";

/** A ready-to-send transaction. */
export interface BuybackCall {
  to: Address;
  data: `0x${string}`;
  value: string;
}

/**
 * A freshly signed (or idempotently replayed) buyback offer.
 *
 * `value_usdc` / `value_source` are added only on the token-first path, and are
 * absent on an idempotent replay of an existing offer.
 */
export interface BuybackOffer {
  /** The EIP-712 signature over the `OfferRequest`. */
  offer_signature: string;
  /** The token actually offered on (the GradedCard token for a since-graded card). */
  token_id: string;
  item_type: string;
  /** The NFT contract the offer is against. */
  contract_address: Address;
  /** The CardOS signer that fronts the USDC when the offer is accepted. */
  requester: Address;
  /** The holder the offer was signed against (snapshotted at creation). */
  target: Address;
  chain_id: number;
  deadline: IsoDate | null;
  /** Offer price in USDC micros. */
  price: MicrosString;
  price_usdc: UsdcString;
  /** What the holder nets after the marketplace fee. */
  seller_receives_usdc: UsdcString;
  marketplace_fee_usdc: UsdcString;
  offer_id: number | null;
  /** The market value the price was derived from. Token-first path only. */
  value_usdc?: UsdcString;
  /** Token-first path only. */
  value_source?: BuybackValueSource;
  /** `true` when an existing active offer was returned instead of re-signing. */
  idempotent?: boolean;
  note: string;
}

/**
 * One row from `buyback.offers()` / `buyback.get()`.
 *
 * `purchase_id` is present on the token-resolved path (`null` for token-first
 * offers) and can be absent altogether when the offers were looked up by
 * purchase id, so treat it as optional.
 */
export interface BuybackOfferSummary {
  offer_id: number;
  signature: string;
  token_id: string;
  purchase_id?: number | null;
  /** Marketplace offer state, e.g. `"active"`, `"accepted"`, `"cancelled"`. */
  status: string;
  price_usdc: UsdcString;
  seller_receives_usdc: UsdcString;
  deadline: IsoDate | null;
  accepted_at: IsoDate | null;
  created_at: IsoDate;
}

/** The EIP-712 payload the holder signs with `eth_signTypedData_v4`. */
export interface BuybackTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "OfferRequest";
  message: {
    tokenContractAddress: Address;
    tokenId: string;
    price: MicrosString;
    acceptedCurrency: Address;
    /** Unix seconds, as a string. */
    deadline: string;
    requester: Address;
    chainId: string;
    minSellerAmount: MicrosString;
  };
}

/** Result of `buyback.acceptPrepare()` — everything the HOLDER needs. */
export interface BuybackAcceptPrepareResult {
  offer_id: number;
  /** Read from the LIVE on-chain owner, not the offer's stored `target`. */
  receiver: Address;
  deadline: IsoDate | null;
  price_usdc: UsdcString;
  seller_receives_usdc: UsdcString;
  /**
   * The Marketplace transfers the NFT out of the holder's wallet, so a
   * signature alone is not enough. When `approved` is false the holder must
   * send `call` (a one-time `setApprovalForAll`) before `accept()` succeeds —
   * that approval cannot be relayed.
   */
  nft_approval: {
    approved: boolean;
    holder_owns_token: boolean;
    call: BuybackCall | null;
  };
  /**
   * A pending burn (physical redemption or grading) freezes the token: transfers
   * revert until the holder cancels it, which abandons that redemption/grading.
   */
  transfer_frozen: {
    frozen: boolean;
    burn_type: string | null;
    cancel_call: BuybackCall | null;
  };
  /**
   * Alternative to sign-and-relay: the holder submits `acceptOffer` themselves
   * (`msg.sender == receiver`, so no receiver signature is needed). Gas is on
   * the submitter on this path.
   */
  self_submit: { call: BuybackCall };
  typed_data: BuybackTypedData;
  note: string;
}

/** Result of `buyback.accept()` — the relayed `acceptOffer`. */
export interface BuybackAcceptResult {
  offer_id: number;
  token_id: string;
  transaction_hash: TxHash | null;
  /** The holder that was paid. */
  receiver: Address;
  /** The CardOS signer that fronted the USDC. */
  requester: Address;
  price_usdc: UsdcString;
  seller_receives_usdc: UsdcString;
  /** Always `"submitted"` — final settlement follows via the `buyback.confirmed` webhook. */
  status: string;
  note: string;
}

export interface BuybackCreateParams extends RequestOverrides {
  /** On-chain token id (raw Card or GradedCard NFT). */
  token_id: string;
  /** Only needed when the same numeric id exists as both (else 409 `ambiguous_token`). */
  item_type?: BuybackItemType;
  /** Optional override; cannot exceed the item value (400 `price_too_high`). */
  offer_price_usdc?: UsdcString;
}

export interface BuybackCreateForPurchaseParams extends RequestOverrides {
  /** Required if the purchase has multiple items. Ignored on the token-id path. */
  token_id?: string;
  /** Token-id path only. */
  item_type?: BuybackItemType;
  offer_price_usdc?: UsdcString;
}

export interface BuybackOffersParams extends RequestOverrides {
  token_id: string;
}

export interface BuybackAcceptPrepareParams extends RequestOverrides {
  item_type?: BuybackItemType;
}

export interface BuybackAcceptParams extends RequestOverrides {
  /** The holder's signature over the prepared `typed_data`. */
  receiver_signature: string;
  item_type?: BuybackItemType;
}
