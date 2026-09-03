/**
 * Webhook registry + event payload types.
 *
 * Two halves live here:
 *  - the REST shapes behind `cardos.webhooks` (`WebhookRegistration`,
 *    `WebhookDelivery`, …);
 *  - the delivered-event shapes behind `@ripdotfun/cardos-sdk/webhooks`
 *    (`WebhookEvent` and its per-event `data` payloads).
 *
 * Every exported name is `Webhook*`-prefixed so nothing collides with the
 * resource types re-exported from the same barrel.
 */

import type { Address, IsoDate, TxHash, UsdcString } from "./common.js";

// ---------------------------------------------------------------------------
// Event type registry
// ---------------------------------------------------------------------------

/**
 * Every event you can subscribe to.
 *
 * One registry serves both CardOS products, so the same four endpoints manage
 * Gacha / Instant Pack subscriptions (`purchase.*`, `buyback.*`, `payout.*`, …)
 * and Card Data subscriptions (`card.*`, `expansion.released`,
 * `sealed.price_updated`, `population.updated`). Which events you receive
 * depends entirely on the `event_types` you register with.
 */
export const WEBHOOK_EVENT_TYPES = [
  // Gacha / Instant Pack
  "deposit.credited",
  "purchase.reserved",
  "purchase.submitted",
  "purchase.fulfilled",
  "purchase.refunded",
  "purchase.failed",
  "instant_purchase.reserved",
  "instant_purchase.submitted",
  "instant_purchase.fulfilled",
  "instant_purchase.refunded",
  "instant_purchase.failed",
  "buyback.confirmed",
  "buyback.transfer_held",
  "buyback.card_transferred",
  "buyback.transfer_failed",
  "redemption.prepared",
  "redemption.updated",
  "pool.item_pulled",
  "sellback.confirmed",
  "payout.statement_ready",
  "payout.paid",
  // Card Data
  "card.price_updated",
  "card.added",
  "card.updated",
  "expansion.released",
  "sealed.price_updated",
  "population.updated",
] as const;

/** One of the documented delivered event names. */
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** True when `value` is a known event name (narrows an untrusted string). */
export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return (
    typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Registry (REST) shapes
// ---------------------------------------------------------------------------

/** A registered webhook endpoint. Secrets are never included after creation. */
export interface WebhookRegistration {
  id: number;
  url: string;
  /** Subscribed events. `[]` / `null` means "everything". */
  event_types: string[] | null;
  is_active: boolean;
  created_at: IsoDate;
  updated_at?: IsoDate;
}

/**
 * The register response — the only place `signing_secret` is ever returned.
 * Store it before the process exits; there is no way to read it back.
 */
export interface WebhookRegistrationWithSecret extends WebhookRegistration {
  /** 64-hex HMAC-SHA256 signing secret. Shown ONCE. */
  signing_secret: string;
}

/**
 * Narrows which deliveries a Card Data subscription receives. Without them
 * `card.price_updated` is a firehose across the whole catalog.
 */
export interface WebhookFilters {
  /** Only events for one game id. */
  game?: string;
  /** Only cards in one expansion. */
  expansion_id?: string;
  /** A watchlist of up to 5,000 card ids for this endpoint. */
  card_ids?: readonly string[];
  /** Only fire when the move is at least this large, in either direction. */
  min_change_pct?: number;
  /** Only graded-tier moves, e.g. `{ company: "PSA", grade: "10" }`. */
  grade?: { company?: string; grade?: string };
}

export interface WebhookRegisterParams {
  /**
   * Public HTTPS endpoint. Private, loopback and link-local URLs are rejected —
   * the endpoint must be publicly reachable.
   */
  url: string;
  /** Subscribe to a subset. Omit to receive every event. */
  event_types?: readonly WebhookEventType[];
  /** Narrow the Card Data events this endpoint receives. */
  filters?: WebhookFilters;
}

/** `{ id, deleted: true }` from `DELETE /api/v1/webhooks/{id}`. */
export interface WebhookDeleteResult {
  id: number;
  deleted: true;
}

/** Delivery attempt state in the debug log. */
export type WebhookDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED";

/** One row of `GET /api/v1/webhooks/deliveries`. */
export interface WebhookDelivery {
  id: number;
  webhook_id: number;
  event_type: string;
  /** Same value as the `X-Mystery-Delivery` header — dedupe on this. */
  event_id: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_retry_at: IsoDate | null;
  delivered_at: IsoDate | null;
  created_at: IsoDate;
}

// ---------------------------------------------------------------------------
// Delivered event envelope
// ---------------------------------------------------------------------------

/** Anything `constructEvent` will read headers out of. */
export type WebhookHeadersInput =
  | Headers
  | Record<string, string | string[] | undefined>;

/**
 * Common fields on every parsed event. `delivery_id` and `timestamp` come from
 * the request headers, so they are only present when `constructEvent` was
 * given headers (rather than a bare `signature`).
 */
export interface WebhookEventBase {
  /** The event id from the body (`"<event>:<key>"`). Matches `X-Mystery-Delivery`. */
  id: string;
  /** `X-Mystery-Delivery`, when headers were supplied. Dedupe on this. */
  delivery_id?: string;
  /** `X-Mystery-Timestamp` as unix milliseconds, when headers were supplied. */
  timestamp?: number;
}

// --- data payloads, one per event type ------------------------------------

/** `deposit.credited` — an on-chain deposit was credited to a custodial balance. */
export interface WebhookDepositCreditedData {
  deposit_id: number;
  /** Integer USDC micros as a string. */
  amount: string;
  amount_usdc: UsdcString;
  chain_in: string;
  token_in: string;
  tx_hash: TxHash;
}

/** A revealed item inside `purchase.fulfilled`. Same shape as `Purchase.items[]`. */
export interface WebhookPurchaseItem {
  token_id: string | null;
  item_type: string;
  /** `card` for cards/slabs, `product` for packets & sealed, `unknown` when unresolved. */
  category: "card" | "product" | "unknown";
  /** Card Data catalog id (`swsh7-215`). `null` when the token maps to no card. */
  card_id?: string | null;
  name: string | null;
  image_url: string | null;
  /** Decimal USD string. Never `Number()` it. */
  value_usd: string | null;
  rarity?: string | null;
  card_number?: string | null;
  set_id?: string | null;
}

export interface WebhookPurchaseReservedData {
  purchase_id: number;
  status: "RESERVED";
}

export interface WebhookPurchaseSubmittedData {
  purchase_id: number;
  status: "SUBMITTED";
  transaction_hash?: TxHash;
  /** Custodial path only. */
  onchain_request_id?: string;
  /** Present on the non-custodial submit path. */
  custody?: "NON_CUSTODIAL";
}

export interface WebhookPurchaseFulfilledData {
  purchase_id: number;
  status: "FULFILLED";
  onchain_request_id?: string;
  /**
   * The hydrated reveal, the same shape `GET /mystery/purchase/{id}` returns.
   * Hydration is best-effort: when the key is absent, fall back to fetching the
   * purchase by `purchase_id`.
   */
  items?: WebhookPurchaseItem[];
}

export interface WebhookPurchaseRefundedData {
  purchase_id: number;
  status: "REFUNDED";
  onchain_request_id?: string;
}

export interface WebhookPurchaseFailedData {
  purchase_id: number;
  status: "FAILED";
  /** Why it failed before broadcast, or `"unknown"`. */
  reason: string;
}

export interface WebhookInstantPurchaseReservedData {
  purchase_id: number;
  status: "RESERVED";
}

export interface WebhookInstantPurchaseSubmittedData {
  purchase_id: number;
  status: "SUBMITTED";
  transaction_hash?: TxHash;
  store_request_id?: string | number | null;
  pool_request_id?: string | number | null;
  custody?: "NON_CUSTODIAL";
}

/**
 * `instant_purchase.fulfilled` carries the full purchase (the same body
 * `GET /api/v1/instant/purchase/{id}` returns, including `cards`), not the thin
 * `{ purchase_id, status }` of the other instant events. Only `id` /
 * `purchase_id` / `status` are guaranteed; hydration is best-effort, so fetch
 * the purchase when the rest is missing.
 */
export interface WebhookInstantPurchaseFulfilledData {
  id?: number;
  purchase_id?: number;
  status: string;
  [field: string]: unknown;
}

export interface WebhookInstantPurchaseRefundedData {
  purchase_id: number;
  status: "REFUNDED";
}

export interface WebhookInstantPurchaseFailedData {
  purchase_id: number;
  status: "FAILED";
  reason: string;
}

/** `buyback.confirmed` — an offer was accepted on-chain. */
export interface WebhookBuybackConfirmedData {
  /** `null` for token-first offers (no linked mystery purchase). */
  purchase_id: number | null;
  offer_id: number;
  token_id: string;
  status: "accepted";
  seller_receives_usdc: UsdcString;
}

/**
 * `buyback.transfer_held` — the bought-back card reached the pool signer and is
 * held pending forwarding to your pool wallet.
 */
export interface WebhookBuybackTransferHeldData {
  purchase_id: number | null;
  offer_id: number;
  offer_signature: string;
  token_id: string;
  reason: string;
  message: string;
}

/** `buyback.card_transferred` — the NFT reached the pool wallet. */
export interface WebhookBuybackCardTransferredData {
  purchase_id: number | null;
  offer_id: number;
  offer_signature: string;
  token_id: string;
  contract_address: Address;
  to_address: Address;
  tx_hash: TxHash;
}

/** `buyback.transfer_failed` — forwarding the card failed; the card is held. */
export interface WebhookBuybackTransferFailedData {
  purchase_id: number | null;
  offer_id: number;
  offer_signature: string;
  token_id: string;
  error: string;
}

/** `redemption.prepared` — emitted inline by `POST /mystery/redemption/prepare`. */
export interface WebhookRedemptionPreparedData {
  redemption_id: number;
  /** `null` for token-first redemptions. */
  purchase_id: number | null;
  token_id: string;
  item_type: string;
  status: string;
}

/**
 * `redemption.updated` — one per status transition thereafter (burn,
 * fulfillment, completion, failure).
 */
export interface WebhookRedemptionUpdatedData {
  redemption_id: number;
  purchase_id: number | null;
  token_id: string;
  item_type: string;
  status: string;
  burn_tx_hash: TxHash | null;
  failure_reason: string | null;
}

/**
 * `pool.item_pulled` — pool model: a pull delivered an item from your own pool
 * inventory, so the item lands on your bill.
 */
export interface WebhookPoolItemPulledData {
  token_id: string;
  item_type: string;
  contract_address: Address;
  /** Canonical card id; `null` when the item maps to no catalog card. */
  card_id: string | null;
  /** Which catalog the `card_id` belongs to. */
  category: string | null;
  game: string | null;
  /** Recipient address. */
  to: Address;
  transaction_hash: TxHash | null;
  amount_usdc: UsdcString;
  value_source: string;
  /** True when the item could not be valued. */
  value_unknown: boolean;
  usage_id: number;
}

/**
 * `sellback.confirmed` — a holder sold cards back to the pool. `total_usdc` is
 * what the pool paid, and is the deduction in your net revenue.
 */
export interface WebhookSellbackConfirmedData {
  sellback_id: number;
  seller: Address;
  token_ids: string[];
  total_usdc: UsdcString;
  transaction_hash: TxHash;
}

/** Per-product breakdown inside a payout statement. */
export interface WebhookPayoutProductBreakdown {
  packs: number;
  gross_usdc: UsdcString;
  /** Present on the `tier` breakdown only. */
  sellback_usdc?: UsdcString;
  net_usdc: UsdcString;
  share_bps: number;
  share_usdc: UsdcString;
}

/**
 * `payout.statement_ready` / `payout.paid` — the frozen revenue-share
 * statement: gross, sell-backs, net and your share. Both events carry the same
 * shape, so your ledger can mirror it from the delivery alone.
 */
export interface WebhookPayoutData {
  payout_id: number;
  period: { kind: string; from: IsoDate; to: IsoDate };
  qualifying_packs: number;
  gross_usdc: UsdcString;
  sellback_count: number;
  sellback_usdc: UsdcString;
  net_usdc: UsdcString;
  revenue_share_bps: number;
  /** e.g. `"70.00"`. */
  revenue_share_pct: string;
  revenue_share_usdc: UsdcString;
  fees_usdc: UsdcString;
  rip_retained_usdc: UsdcString;
  by_product: {
    tier: WebhookPayoutProductBreakdown;
    instant: WebhookPayoutProductBreakdown;
  };
  payout_usdc: UsdcString;
  payout_micros: string;
  status: string;
  payout_address: Address | null;
  chain: string | null;
  tx_hash: TxHash | null;
  paid_at: IsoDate | null;
  [field: string]: unknown;
}

// --- Card Data payloads ---------------------------------------------------

/**
 * `card.price_updated` — a card's market value moved past the endpoint's
 * `min_change_pct` filter. `condition` is present on raw moves, `grade` on
 * graded-tier moves.
 *
 * Card Data prices are JSON numbers, the one place this API does not use money
 * strings.
 */
export interface WebhookCardPriceUpdatedData {
  card_id: string;
  game: string;
  previous: number | null;
  current: number | null;
  change_pct: number;
  condition?: string;
  grade?: string;
}

/** `card.added` — a new card was ingested, usually with a set release. */
export interface WebhookCardAddedData {
  card_id: string;
  game: string;
  expansion_id: string;
}

/** `card.updated` — card metadata was corrected; `changed` names the fields. */
export interface WebhookCardUpdatedData {
  card_id: string;
  game: string;
  changed: string[];
}

/** `expansion.released` — an expansion's release date passed and its cards went live. */
export interface WebhookExpansionReleasedData {
  expansion_id: string;
  game: string;
  /** Cards in the expansion. */
  total: number;
}

/** `sealed.price_updated` — a sealed product's market value moved past your threshold. */
export interface WebhookSealedPriceUpdatedData {
  product_id: string;
  game: string;
  previous: number | null;
  current: number | null;
  change_pct: number;
}

/** `population.updated` — a grading company published a new report for a watched card. */
export interface WebhookPopulationUpdatedData {
  card_id: string;
  game: string;
  /** Grading company, e.g. `PSA`. */
  company: string;
  /** Graded population total. */
  total: number;
  gem_rate: number | null;
}

// --- the discriminated union ----------------------------------------------

interface WebhookEventOf<E extends WebhookEventType, D> extends WebhookEventBase {
  event: E;
  data: D;
}

export type WebhookDepositCreditedEvent = WebhookEventOf<
  "deposit.credited",
  WebhookDepositCreditedData
>;
export type WebhookPurchaseReservedEvent = WebhookEventOf<
  "purchase.reserved",
  WebhookPurchaseReservedData
>;
export type WebhookPurchaseSubmittedEvent = WebhookEventOf<
  "purchase.submitted",
  WebhookPurchaseSubmittedData
>;
export type WebhookPurchaseFulfilledEvent = WebhookEventOf<
  "purchase.fulfilled",
  WebhookPurchaseFulfilledData
>;
export type WebhookPurchaseRefundedEvent = WebhookEventOf<
  "purchase.refunded",
  WebhookPurchaseRefundedData
>;
export type WebhookPurchaseFailedEvent = WebhookEventOf<
  "purchase.failed",
  WebhookPurchaseFailedData
>;
export type WebhookInstantPurchaseReservedEvent = WebhookEventOf<
  "instant_purchase.reserved",
  WebhookInstantPurchaseReservedData
>;
export type WebhookInstantPurchaseSubmittedEvent = WebhookEventOf<
  "instant_purchase.submitted",
  WebhookInstantPurchaseSubmittedData
>;
export type WebhookInstantPurchaseFulfilledEvent = WebhookEventOf<
  "instant_purchase.fulfilled",
  WebhookInstantPurchaseFulfilledData
>;
export type WebhookInstantPurchaseRefundedEvent = WebhookEventOf<
  "instant_purchase.refunded",
  WebhookInstantPurchaseRefundedData
>;
export type WebhookInstantPurchaseFailedEvent = WebhookEventOf<
  "instant_purchase.failed",
  WebhookInstantPurchaseFailedData
>;
export type WebhookBuybackConfirmedEvent = WebhookEventOf<
  "buyback.confirmed",
  WebhookBuybackConfirmedData
>;
export type WebhookBuybackTransferHeldEvent = WebhookEventOf<
  "buyback.transfer_held",
  WebhookBuybackTransferHeldData
>;
export type WebhookBuybackCardTransferredEvent = WebhookEventOf<
  "buyback.card_transferred",
  WebhookBuybackCardTransferredData
>;
export type WebhookBuybackTransferFailedEvent = WebhookEventOf<
  "buyback.transfer_failed",
  WebhookBuybackTransferFailedData
>;
export type WebhookRedemptionPreparedEvent = WebhookEventOf<
  "redemption.prepared",
  WebhookRedemptionPreparedData
>;
export type WebhookRedemptionUpdatedEvent = WebhookEventOf<
  "redemption.updated",
  WebhookRedemptionUpdatedData
>;
export type WebhookPoolItemPulledEvent = WebhookEventOf<
  "pool.item_pulled",
  WebhookPoolItemPulledData
>;
export type WebhookSellbackConfirmedEvent = WebhookEventOf<
  "sellback.confirmed",
  WebhookSellbackConfirmedData
>;
export type WebhookPayoutStatementReadyEvent = WebhookEventOf<
  "payout.statement_ready",
  WebhookPayoutData
>;
export type WebhookPayoutPaidEvent = WebhookEventOf<"payout.paid", WebhookPayoutData>;
export type WebhookCardPriceUpdatedEvent = WebhookEventOf<
  "card.price_updated",
  WebhookCardPriceUpdatedData
>;
export type WebhookCardAddedEvent = WebhookEventOf<"card.added", WebhookCardAddedData>;
export type WebhookCardUpdatedEvent = WebhookEventOf<"card.updated", WebhookCardUpdatedData>;
export type WebhookExpansionReleasedEvent = WebhookEventOf<
  "expansion.released",
  WebhookExpansionReleasedData
>;
export type WebhookSealedPriceUpdatedEvent = WebhookEventOf<
  "sealed.price_updated",
  WebhookSealedPriceUpdatedData
>;
export type WebhookPopulationUpdatedEvent = WebhookEventOf<
  "population.updated",
  WebhookPopulationUpdatedData
>;

/**
 * An event whose name this SDK version does not know (a newer server emitting
 * an event added after this release). `constructEvent` still returns it rather
 * than dropping a real delivery — guard with `isWebhookEventType(event.event)`
 * before trusting the narrowing if you deploy against a newer API.
 *
 * Deliberately NOT part of `WebhookEvent`: a member with `event: string`
 * defeats discriminated-union narrowing, so `switch (event.event)` would leave
 * `data` as `Record<string, unknown>` in every branch. Use `WebhookAnyEvent`
 * when you want the honest superset.
 */
export interface WebhookUnknownEvent extends WebhookEventBase {
  event: string;
  data: Record<string, unknown>;
}

/**
 * A verified, parsed webhook delivery. Discriminate on `event`:
 *
 * ```ts
 * switch (event.event) {
 *   case "purchase.fulfilled":
 *     event.data.items?.forEach((i) => console.log(i.name, i.value_usd));
 *     break;
 * }
 * ```
 */
export type WebhookEvent =
  | WebhookDepositCreditedEvent
  | WebhookPurchaseReservedEvent
  | WebhookPurchaseSubmittedEvent
  | WebhookPurchaseFulfilledEvent
  | WebhookPurchaseRefundedEvent
  | WebhookPurchaseFailedEvent
  | WebhookInstantPurchaseReservedEvent
  | WebhookInstantPurchaseSubmittedEvent
  | WebhookInstantPurchaseFulfilledEvent
  | WebhookInstantPurchaseRefundedEvent
  | WebhookInstantPurchaseFailedEvent
  | WebhookBuybackConfirmedEvent
  | WebhookBuybackTransferHeldEvent
  | WebhookBuybackCardTransferredEvent
  | WebhookBuybackTransferFailedEvent
  | WebhookRedemptionPreparedEvent
  | WebhookRedemptionUpdatedEvent
  | WebhookPoolItemPulledEvent
  | WebhookSellbackConfirmedEvent
  | WebhookPayoutStatementReadyEvent
  | WebhookPayoutPaidEvent
  | WebhookCardPriceUpdatedEvent
  | WebhookCardAddedEvent
  | WebhookCardUpdatedEvent
  | WebhookExpansionReleasedEvent
  | WebhookSealedPriceUpdatedEvent
  | WebhookPopulationUpdatedEvent;

/**
 * `WebhookEvent` plus the open-ended `WebhookUnknownEvent`. Widen to this when
 * you handle events by name defensively rather than by `switch`.
 */
export type WebhookAnyEvent = WebhookEvent | WebhookUnknownEvent;

/** Narrow `WebhookEvent` to one member by name. */
export type WebhookEventFor<E extends WebhookEventType> = Extract<
  WebhookEvent,
  { event: E }
>;

// ---------------------------------------------------------------------------
// Verification options
// ---------------------------------------------------------------------------

/** Options for `verifyWebhookSignature` (`@ripdotfun/cardos-sdk/webhooks`). */
export interface WebhookVerifyOptions {
  /** The EXACT raw request body. Parsing and re-stringifying breaks the HMAC. */
  payload: string | Uint8Array;
  /** The `X-Mystery-Signature` header: `t=<unix_ms>,sha256=<hex>`. */
  signature: string;
  /** The `signing_secret` returned once by `register()`. */
  secret: string;
  /** Freshness window in ms. Default 300 000 (5 minutes). `0` disables the check. */
  toleranceMs?: number;
  /** Clock override, in ms since epoch. Tests only. */
  now?: number;
}

/** Options for `constructEvent` (`@ripdotfun/cardos-sdk/webhooks`). */
export interface WebhookConstructEventOptions {
  /** The EXACT raw request body. */
  payload: string | Uint8Array;
  /** Request headers — a `Headers` instance or a plain record (case-insensitive). */
  headers?: WebhookHeadersInput;
  /** The signature header value, when you already pulled it out yourself. */
  signature?: string;
  secret: string;
  toleranceMs?: number;
  now?: number;
}
