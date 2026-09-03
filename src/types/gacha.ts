/**
 * Types for `cardos.gacha` — the mystery-pack (combo pool) surface.
 *
 * Field names and casing are the API's own — nothing is renamed on the way
 * through. A key the API always sends but can leave empty is `| null`; a key
 * that can be absent from the response altogether is optional (`?`).
 */

import { OffsetPage } from "../pagination.js";
import type {
  Address,
  IsoDate,
  MicrosString,
  OffsetPagination,
  TxHash,
  UsdcString,
} from "./common.js";

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** `{ id, label }` for the game a tier or feed row belongs to, e.g. `{ id: "onepiece", label: "One Piece" }`. */
export interface GachaGameRef {
  id: string;
  label: string;
}

/**
 * One sellable mystery-pack tier.
 *
 * Price / EV / slot count / active are read live from the on-chain pool with a
 * short last-known-good fallback: `null` means "temporarily unavailable", never
 * "free" or "unsellable" — re-fetch shortly. The display metadata is `null`
 * until a tier metadata row exists.
 */
export interface Tier {
  tier_id: number;
  name: string | null;
  slug: string | null;
  description: string | null;
  /** What the tier yields — `card`, `box`, … */
  variant: string | null;
  game: GachaGameRef | null;
  price_usdc: UsdcString | null;
  /** Pre-formatted `"$25.00"` display price. */
  price_display: string | null;
  price_micros: MicrosString | null;
  target_ev_usdc: UsdcString | null;
  slot_count: number | null;
  active: boolean | null;
  /** Observed pulls; `0` for a tier nobody has bought yet. */
  total_purchases: number;
  last_active_at: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

/**
 * What a slot yields. The union is left open on `TierOddsSlot.slot_type`
 * because an item kind newer than this SDK release arrives as-is.
 */
export type SlotType = "PACKET" | "CARD" | "GRADED_CARD" | "SEALED_PRODUCT";

/** One rarity group's share of a single slot. */
export interface TierOddsSlotGroup {
  group_id: number;
  /** Raw on-chain weight (an integer as a string). */
  weight: string;
  /** Weight share within this slot, `0`–`1`. */
  probability: number;
}

/** One slot of a tier, with the rarity groups it can draw from. */
export interface TierOddsSlot {
  slot_index: number;
  slot_type: SlotType | (string & {});
  min_value_usdc: UsdcString;
  max_value_usdc: UsdcString;
  groups: TierOddsSlotGroup[];
}

/** A rarity group in the weight-derived (`scope: "onchain"`) odds shape. */
export interface OnchainRarityGroup {
  group_id: number;
  /** Falls back to `"Group {id}"` when the group has no metadata row. */
  name: string;
  tier_label: string | null;
  color: string | null;
  min_price: string | null;
  max_price: string | null;
  avg_price: string | null;
  /** Summed on-chain weight across every slot (integer as a string). */
  weight: string;
  /** Weight share across all slots — the expected fraction of pulled items, `0`–`1`. */
  probability: number;
  /** Current inventory in the group. Supplementary: it does not drive the odds. */
  available_count: number;
}

/** Odds derived from the pool's per-slot weights, with the `slots` breakdown. */
export interface OnchainTierOdds {
  tier_id: number;
  scope: "onchain";
  currency: "USDC";
  tier_price_usdc: UsdcString;
  target_ev_usdc: UsdcString;
  slot_count: number;
  active: boolean;
  rarity_groups: OnchainRarityGroup[];
  slots: TierOddsSlot[];
}

/** A rarity group in the inventory-derived fallback shape. */
export interface InventoryRarityGroup {
  group_id: number;
  name: string;
  tier_label: string;
  color: string;
  min_price: string;
  max_price: string;
  avg_price: string;
  available_count: number;
  /** Share of current inventory, `0`–`1` — an availability proxy, not the governed odds. */
  probability: number;
}

/**
 * The availability-derived shape: what is currently in the pool and the average
 * item value, with no per-slot breakdown (`slots` is absent).
 */
export interface InventoryTierOdds {
  tier_id: number;
  scope: "inventory_fallback";
  currency: "USDC";
  total_available: number;
  average_item_value: UsdcString;
  rarity_groups: InventoryRarityGroup[];
}

/**
 * Odds for one tier. Discriminate on `scope`: `"onchain"` carries the per-slot
 * weights, `"inventory_fallback"` carries current availability and the average
 * item value instead. Handle both — which one you get is not yours to choose.
 */
export type TierOdds = OnchainTierOdds | InventoryTierOdds;

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/**
 * One revealed pull in `/feed/recent` or `/feed/winners`.
 *
 * Rows are unique on `(token_id, revealed_at)`, not on `token_id` alone: a card
 * sold back to the pool and pulled again appears once per reveal.
 */
export interface FeedRow {
  token_id: string;
  item_type: string;
  card_name: string | null;
  card_image_url: string | null;
  card_price_usdc: UsdcString | null;
  tier_id: number;
  revealed_at: IsoDate;
  /** The tier's game; `null` when the tier has no metadata row. */
  game: GachaGameRef | null;
}

// ---------------------------------------------------------------------------
// Purchases & reveals
// ---------------------------------------------------------------------------

/**
 * Purchase lifecycle. The documented path is `RESERVED` → `SUBMITTED` →
 * `FULFILLED`. Terminal success: `FULFILLED` / `PARTIALLY_FULFILLED`.
 * Terminal failure: `REFUNDED` / `FAILED`. `PENDING` and `SUBMITTING` are
 * short-lived transitions you may observe while polling.
 */
export type PurchaseStatus =
  | "PENDING"
  | "RESERVED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "FULFILLED"
  | "PARTIALLY_FULFILLED"
  | "REFUNDED"
  | "FAILED";

/** Who paid: the end user's CardOS credits wallet, or their own wallet on-chain. */
export type PurchaseCustody = "CUSTODIAL" | "NON_CUSTODIAL";

/** What a revealed item resolved to. `unknown` = the token has no canonical row yet. */
export type ItemCategory = "card" | "product" | "unknown";

/**
 * One item revealed by a purchase.
 *
 * `card_id`, `rarity`, `card_number` and `set_id` are only serialised for
 * hydrated cards (and `card_id` alone, as `null`, on the unknown fallback), so
 * they are optional rather than nullable.
 */
export interface RevealItem {
  token_id: string;
  /** The revealed token's item type: `CARD` | `GRADED_CARD` | `PACKET` | `SEALED_PRODUCT`. */
  item_type: string;
  category: ItemCategory;
  /** Canonical Card Data id (e.g. `base1-4`) — join straight onto `cardos.cards`. */
  card_id?: string | null;
  name: string | null;
  image_url: string | null;
  value_usd: UsdcString | null;
  rarity?: string | null;
  card_number?: string | null;
  set_id?: string | null;
}

/**
 * A pack purchase. `items` appears once the reveal has settled — which is why
 * `waitForReveal()` resolves to the whole purchase rather than just a status.
 */
export interface Purchase {
  id: number;
  /** `"{partner-slug}-{id}"` attribution tag. Absent when the partner has no slug. */
  memo?: string;
  status: PurchaseStatus;
  custody: PurchaseCustody;
  tier_id: number;
  /** Always `1` — one pack per call. */
  quantity: number;
  /** Price in USDC micros. */
  price: MicrosString;
  price_usdc: UsdcString;
  /** The same number as `price_usdc`, in the volume-reporting vocabulary. */
  volume_usdc: UsdcString;
  onchain_request_id: string | null;
  transaction_hash: TxHash | null;
  purchaser_address: Address | null;
  failure_reason: string | null;
  reserved_at: IsoDate | null;
  submitted_at: IsoDate | null;
  fulfilled_at: IsoDate | null;
  created_at: IsoDate;
  /** Present once the reveal has settled (`FULFILLED` / `PARTIALLY_FULFILLED`). */
  items?: RevealItem[];
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** The end user a collection page belongs to, as the server resolved them. */
export interface CollectionUser {
  external_user_id: string | null;
  wallet_address: Address | null;
}

/**
 * One delivered item in an end user's collection. Unlike `RevealItem`, every
 * key is always present here — empty values come back as `null`.
 */
export interface CollectionItem {
  token_id: string;
  item_type: string;
  category: ItemCategory;
  /** Canonical Card Data id; `null` for products and unmapped tokens. */
  card_id: string | null;
  name: string | null;
  image_url: string | null;
  value_usd: UsdcString | null;
  rarity: string | null;
  card_number: string | null;
  set_id: string | null;
  purchase_id: number;
  tier_id: number;
  /** When the delivering purchase fulfilled (falls back to its creation time). */
  acquired_at: IsoDate;
  /**
   * `true` while the user's wallet still holds the token; `false` once it was
   * sold back / redeemed / burned / transferred; `null` for non-cards or when
   * the user has no known wallet.
   */
  still_owned: boolean | null;
}

/**
 * An `OffsetPage<CollectionItem>` that also carries the resolved `user`.
 *
 * `GET /mystery/collection` returns `{ user, items }` beside `pagination`, and
 * dropping `user` would force a second call to learn which wallet the
 * `still_owned` flags were computed against. Subclassing the page keeps the
 * result directly iterable
 * (`for await (const item of await cardos.gacha.collection(…))`) and makes
 * `next()` return a `CollectionPage` too, so `user` survives paging.
 */
export class CollectionPage extends OffsetPage<CollectionItem> {
  constructor(
    /** The end user these items belong to. */
    readonly user: CollectionUser,
    items: CollectionItem[],
    pagination: OffsetPagination,
    fetchPage: (offset: number) => Promise<CollectionPage>,
  ) {
    super(items, pagination, fetchPage);
  }

  override next(): Promise<CollectionPage | null> {
    return super.next() as Promise<CollectionPage | null>;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Pulls and volume for one tier. */
export interface PartnerTierStats {
  tier_id: number;
  pulls: number;
  /** USDC micros. */
  volume: MicrosString;
  volume_usdc: UsdcString;
}

/** Buyback activity rolled up for the partner. */
export interface PartnerBuybackStats {
  offers: number;
  accepted: number;
  offered_volume_usdc: UsdcString;
  accepted_volume_usdc: UsdcString;
}

/**
 * This key's totals: packs opened by outcome, gross volume overall and per
 * tier, and buyback activity.
 */
export interface PartnerStats {
  partner_slug: string | null;
  currency: "USDC";
  total_purchases: number;
  fulfilled: number;
  refunded: number;
  failed: number;
  /** USDC micros. */
  total_volume: MicrosString;
  total_volume_usdc: UsdcString;
  by_tier: PartnerTierStats[];
  buyback: PartnerBuybackStats;
}

// ---------------------------------------------------------------------------
// Non-custodial purchase (prepare / submit)
// ---------------------------------------------------------------------------

/**
 * Machine-readable call type. Dispatch on this, never on `description` or the
 * 4-byte selector: under account abstraction an `erc20-approve` must be sent as
 * its own userop or gas estimation fails.
 */
export type UnsignedCallKind =
  | "erc20-approve"
  | "purchase"
  | "set-approval-for-all"
  | "sellback"
  | "burn"
  | "shipping-payment";

/** One unsigned transaction for the end user's wallet to send, in order. */
export interface UnsignedCall {
  to: Address;
  /** 0x-prefixed calldata. */
  data: string;
  kind: UnsignedCallKind;
  description: string;
}

/** The generic "here is calldata for the end user to sign" envelope. */
export interface UnsignedCalls {
  chain_id: number;
  calls: UnsignedCall[];
}

/**
 * `POST /mystery/purchase/prepare` — the approve + purchase calls the end user
 * sends from their own wallet. Preparing creates nothing server-side.
 */
export interface PurchasePrepareResult extends UnsignedCalls {
  /** USDC contract address. */
  payment_token: Address;
  /** `MysteryComboPool` address. */
  contract: Address;
  /** Approval amount, in USDC micros. */
  max_price: MicrosString;
  max_price_usdc: UsdcString;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** What the price was actually computed for. */
export type PricedItemType = "CARD" | "GRADED_CARD";

/**
 * Market value plus the price the pool would pay to buy the item back.
 * A token that resolves to a graded slab is priced from the
 * `(card, grading company, grade)` feed, never from the raw card value.
 */
export interface PriceQuote {
  card_id: string;
  /** Echoes the query; `null` when queried by `card_id`. */
  token_id: string | null;
  item_type: PricedItemType;
  market_value_usdc: UsdcString;
  buyback_price_usdc: UsdcString;
  /** `card_raw_price` | `buyback_oracle` | `graded_market_price`. */
  value_source: string;
  /** Last oracle refresh; `null` when no oracle row exists. */
  updated_at: IsoDate | null;
}
