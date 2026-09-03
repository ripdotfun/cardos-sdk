/**
 * Native combo-pool sell-back (TIER partners — you sell CardOS tiers).
 *
 * The pack price already funded the on-chain buyback float, so a sale is paid
 * from that float, the card restocks the pool it came from, and nothing is
 * fronted or owed: a sell-back reduces net revenue rather than creating a debt.
 * The HOLDER signs — CardOS never holds the NFT and never broadcasts for them.
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

/** Why a token cannot be sold back. `null` when it can. */
export type SellbackIneligibleReason =
  /** Never pool-distributed, or already sold back. */
  | "no_window"
  /** The wallet is not the card's original recipient. */
  | "wrong_holder"
  /** The buyback window has closed — this card can never be sold back. */
  | "window_expired"
  /** The oracle has no price for the card's group; the contract would revert. */
  | "value_unknown";

/** Per-token eligibility + payout from `sellback.quote()`. */
export interface SellbackQuoteItem {
  token_id: string;
  eligible: boolean;
  reason: SellbackIneligibleReason | null;
  /** When this card's buyback window closes. After it, sell-back is impossible. */
  expires_at: IsoDate | null;
  /** Oracle pricing group the card belongs to. */
  group_id: number | null;
  /** Oracle value before the pool's discount. */
  oracle_value_usdc: UsdcString | null;
  /** What the pool pays: oracle group price × the pool's discount permille. */
  payout_usdc: UsdcString | null;
  payout_micros: MicrosString | null;
  /** Came from a pack whose contents included a raw card — the revenue-share qualifying subset. */
  from_raw_card_pack: boolean;
}

/** Result of `sellback.quote()`. */
export interface SellbackQuote {
  /** The holder, lowercased. */
  seller: Address;
  items: SellbackQuoteItem[];
  /** Just the sellable ones — exactly what `prepare()` will encode. */
  eligible_token_ids: string[];
  total_payout_micros: MicrosString;
  total_payout_usdc: UsdcString;
  /** The holder still owes the one-time `setApprovalForAll` (prepare includes it as a call). */
  approval_needed: boolean;
  /** `null` when the pool balance could not be read. */
  pool_liquidity_usdc: UsdcString | null;
  /** The contract checks this too, so a `false` here is a revert you can avoid. */
  sufficient_liquidity: boolean;
}

/** Machine-readable call type — dispatch on this, never on the description. */
export type SellbackCallKind = "set-approval-for-all" | "sellback";

export interface SellbackUnsignedCall {
  to: Address;
  data: `0x${string}`;
  kind: SellbackCallKind;
  description: string;
}

/** Result of `sellback.prepare()` — the calls the HOLDER signs, in order. */
export interface SellbackPrepareResult {
  chain_id: number;
  /** MysteryComboPool — the contract `acceptCardBuyback` runs on. */
  contract: Address;
  /** Card NFT contract the one-time approval targets. */
  card_contract: Address;
  /** The buyback pool contract — the operator being approved, and the payer. */
  buyback_pool: Address;
  seller: Address;
  /** The eligible subset actually encoded into the call. */
  token_ids: string[];
  quoted_payout_usdc: UsdcString;
  /** The slippage floor encoded into the call, in micros. */
  min_total: MicrosString;
  min_total_usdc: UsdcString;
  approval_needed: boolean;
  calls: SellbackUnsignedCall[];
}

/** One recorded sell-back (from `sellback.submit()` and `sellback.list()`). */
export interface SellbackRecord {
  sellback_id: number;
  seller: Address;
  /** Currently always `"CARD"`. */
  item_type: string;
  token_ids: string[];
  /** Decoded from the on-chain `CardSellExecuted` log — never from your request. */
  total_usdc: UsdcString;
  total_micros: MicrosString;
  /** How many cards in the sale came from a raw-card pack (the revenue-share subset). */
  raw_card_count: number;
  transaction_hash: TxHash;
  sold_at: IsoDate | null;
}

export interface SellbackQuoteParams extends RequestOverrides {
  /** The holder — must be the wallet that received the cards. */
  wallet_address: Address;
  /** Card token ids to quote. Max 50. */
  token_ids: string[];
}

export interface SellbackPrepareParams extends RequestOverrides {
  wallet_address: Address;
  /** Max 50, and every one must be eligible — the on-chain call is all-or-nothing. */
  token_ids: string[];
  /** Minimum acceptable total. Defaults to the quote less `slippage_bps`. */
  min_total_usdc?: UsdcString;
  /** Slippage tolerance in bps when `min_total_usdc` is omitted. Default 100 (1%). */
  slippage_bps?: number;
}

export interface SellbackSubmitParams extends RequestOverrides {
  /** The mined sell-back transaction. */
  transaction_hash: TxHash;
  /** The seller, for your own correlation. Optional. */
  wallet_address?: Address;
  /** Your id for the end user, for your own correlation. Optional. */
  external_user_id?: string;
}

export type SellbackListParams = OffsetPageParams & RequestOverrides;
