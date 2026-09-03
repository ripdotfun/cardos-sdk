/**
 * `cardos.gacha` — mystery packs.
 *
 * The whole point of the SDK in one flow:
 *
 *     const purchase = await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });
 *     const { items } = await cardos.gacha.waitForReveal(purchase.id);
 *
 * Everything lives under `/api/v1/mystery`. Two purchase models share the same
 * `Purchase` shape: custodial (`purchase()`, paid from the end user's CardOS
 * credits) and non-custodial (`prepare()` → the user signs → `submit()`).
 */

import { newIdempotencyKey } from "../http.js";
import type { OffsetPage } from "../pagination.js";
import { poll, type PollOptions } from "../polling.js";
import type {
  Address,
  Envelope,
  OffsetPageParams,
  RequestOverrides,
  TxHash,
  UsdcString,
  UserIdentity,
} from "../types/common.js";
import {
  CollectionPage,
  type CollectionItem,
  type CollectionUser,
  type FeedRow,
  type GachaGameRef,
  type PartnerStats,
  type PriceQuote,
  type PricedItemType,
  type Purchase,
  type PurchasePrepareResult,
  type PurchaseStatus,
  type Tier,
  type TierOdds,
} from "../types/gacha.js";
import { Resource } from "./base.js";

const BASE = "/api/v1/mystery";

/** The cached partner reads accept `fresh` to bypass the response cache. */
export interface FreshOverride {
  /**
   * `true` bypasses the shared response cache and recomputes from source.
   * Meant for a manual refresh, not for polling: it carries its own budget of
   * 10 calls per minute per key, and past that you get a `429` while a plain
   * read still answers from cache.
   */
  fresh?: boolean;
}

export interface CatalogParams extends RequestOverrides, FreshOverride {
  /** Filter by game id: `pokemon` | `onepiece` | `azuki`. */
  game?: string;
  /** Filter by what the tier yields, e.g. `card`. */
  variant?: string;
  /** `true` = only tiers the pool is currently selling. */
  active?: boolean;
}

export interface OddsParams extends RequestOverrides, FreshOverride {}

export interface FeedParams extends OffsetPageParams, RequestOverrides, FreshOverride {
  /** Filter to one game (catalog ids). Tiers with no game metadata drop out when set. */
  game?: string;
}

interface PurchaseParamsBase extends RequestOverrides {
  /** Tier to buy. One pack per call — a multi-pull is N calls with N keys. */
  tier_id: number;
  /** Price cap in USDC; defaults to the current tier price. */
  max_price_usdc?: UsdcString;
  /**
   * Your own idempotency key. Omit it and the SDK mints a UUID. Sent as the
   * `Idempotency-Key` header, never in the body.
   */
  idempotency_key?: string;
}

/** Params for `purchase()`. At least one of `external_user_id` / `wallet_address` is required. */
export type PurchaseParams = PurchaseParamsBase & UserIdentity;

export interface ListPurchasesParams extends OffsetPageParams, RequestOverrides {
  status?: PurchaseStatus;
  /** Filter to one end user. */
  external_user_id?: string;
  /** Filter to one end user. */
  wallet_address?: Address;
}

interface CollectionParamsBase extends OffsetPageParams, RequestOverrides {}

/** Params for `collection()`. The end-user identity is required here, not optional. */
export type CollectionParams = CollectionParamsBase & UserIdentity;

export interface PreparePurchaseParams extends RequestOverrides {
  /** End-user wallet that will sign and pay. */
  wallet_address: Address;
  tier_id: number;
  /** Approval cap in USDC; defaults to the last-seen tier price. */
  max_price_usdc?: UsdcString;
}

interface SubmitPurchaseParamsBase extends RequestOverrides {
  tier_id: number;
  /** Hash of the broadcast purchase tx. Submit only after it is mined. */
  transaction_hash: TxHash;
  /** Request id from the receipt logs — speeds up linking the reveal. */
  request_id?: string;
}

/** Params for `submit()`. The identity that signed the purchase is required. */
export type SubmitPurchaseParams = SubmitPurchaseParamsBase & UserIdentity;

interface PriceParamsBase extends RequestOverrides, FreshOverride {
  /** `CARD` or `GRADED_CARD`, to disambiguate a token id that exists as both (the slab wins otherwise). */
  item_type?: PricedItemType;
}

/** Params for `price()` — exactly one of `card_id` / `token_id`. */
export type PriceParams = PriceParamsBase &
  ({ card_id: string; token_id?: never } | { token_id: string; card_id?: never });

export class GachaResource extends Resource {
  /**
   * The mystery-pack tiers this key can sell — name, game, live price, EV and
   * observed volume.
   *
   * `GET /api/v1/mystery/catalog` · scope `read:catalog`.
   * A tier that has never been purchased still appears, so a newly launched
   * tier is sellable immediately. `price_usdc: null` means the live price read
   * is temporarily unavailable — re-fetch, never treat it as free.
   *
   * Errors: `403 Insufficient permissions` (key lacks `read:catalog`).
   */
  async catalog(params?: CatalogParams): Promise<Tier[]> {
    const { overrides, rest } = this.split(params);
    const data = await this.http.data<{ tiers: Tier[] }>({
      ...overrides,
      method: "GET",
      path: `${BASE}/catalog`,
      query: { ...rest },
    });
    return data.tiers ?? [];
  }

  /**
   * Every game with at least one tier on offer — the list a storefront builds
   * its game filter from. Computed server-side BEFORE any `game` / `variant` /
   * `active` filter, so it never shrinks to the current selection.
   *
   * `GET /api/v1/mystery/catalog` (same call as `catalog()`, reads `data.games`)
   * · scope `read:catalog`.
   */
  async games(params?: Pick<CatalogParams, keyof RequestOverrides | "fresh">): Promise<GachaGameRef[]> {
    const { overrides, rest } = this.split(params);
    const data = await this.http.data<{ games?: GachaGameRef[] }>({
      ...overrides,
      method: "GET",
      path: `${BASE}/catalog`,
      query: { ...rest },
    });
    return data.games ?? [];
  }

  /**
   * The rarity breakdown, what is currently available and the value per item
   * for one tier — what you show a player before they buy.
   *
   * `GET /api/v1/mystery/catalog/{tier_id}/odds` · scope `read:catalog`.
   *
   * Read `scope` first and branch on it rather than probing for fields.
   * Normally it is `"onchain"`: the authoritative odds governed by the pool
   * contract's own tier weights, with the per-slot breakdown. If the chain is
   * briefly unreachable you get `"inventory_fallback"` instead —
   * availability-derived odds (`total_available` / `average_item_value`), a
   * different set of fields, and NOT the published pull rates, so only publish
   * odds from the `"onchain"` shape.
   *
   * Errors: `400 invalid_tier` (not a known tier).
   */
  async odds(tierId: number, params?: OddsParams): Promise<TierOdds> {
    const { overrides, rest } = this.split(params);
    return this.http.data<TierOdds>({
      ...overrides,
      method: "GET",
      path: `${BASE}/catalog/${encodeURIComponent(String(tierId))}/odds`,
      query: { ...rest },
    });
  }

  /**
   * The live pull feeds. All three page with `limit` (1–100, default 50) and
   * `offset` (0–10000) and return `OffsetPage<FeedRow>`; rows are unique on
   * `(token_id, revealed_at)`, not on `token_id` alone, so key any UI list on
   * the pair.
   *
   * Scope `read:catalog` on every one.
   */
  readonly feed = {
    /**
     * Most recently revealed items across the whole pool.
     *
     * `GET /api/v1/mystery/feed/recent` · scope `read:catalog`.
     * Pass `game` to keep a single-game storefront from over-fetching the pool.
     */
    recent: (params?: FeedParams): Promise<OffsetPage<FeedRow>> =>
      this.feedPage("recent", params),

    /**
     * The same rows ordered by item value — a "biggest wins" strip.
     *
     * `GET /api/v1/mystery/feed/winners` · scope `read:catalog`.
     */
    winners: (params?: FeedParams): Promise<OffsetPage<FeedRow>> =>
      this.feedPage("winners", params),

    /**
     * The recent feed narrowed to packs opened through this API key — your own
     * activity view.
     *
     * `GET /api/v1/mystery/feed/recent?scope=mine` · scope `read:catalog`.
     */
    mine: (params?: FeedParams): Promise<OffsetPage<FeedRow>> =>
      this.feedPage("recent", params, "mine"),
  };

  private feedPage(
    which: "recent" | "winners",
    params?: FeedParams,
    scope?: "mine",
  ): Promise<OffsetPage<FeedRow>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...filters } = rest;
    return this.offsetPage<FeedRow>(
      {
        ...overrides,
        path: `${BASE}/feed/${which}`,
        query: { ...filters, scope },
      },
      "items",
      { limit, offset },
    );
  }

  /**
   * Buy one pack, paid from the end user's custodial CardOS balance. No
   * signing, no chain awareness on your side.
   *
   * `POST /api/v1/mystery/purchase` → `202` · scope `packs:purchase`.
   *
   * An `Idempotency-Key` is **required** by the API; the SDK mints a UUID when
   * you do not pass `idempotency_key`, so a network retry can never
   * double-charge. A key is bound to its first `(user, tier)` pair — replaying
   * it with a different `tier_id` is a `409 idempotency_mismatch` — so mint one
   * per intent (e.g. when the user taps buy) if you supply your own.
   *
   * The purchase comes back `RESERVED`; the reveal is asynchronous. Feed the id
   * to {@link waitForReveal}, or take the `purchase.fulfilled` webhook.
   *
   * Errors: `400 missing_idempotency_key` (only reachable if you pass an empty
   * `idempotency_key`), `400 invalid_tier`, `400 unsupported_quantity` (one
   * pack per call), `402 insufficient_funds` → `InsufficientFundsError`,
   * `409 idempotency_mismatch` → `ConflictError`,
   * `503 relayer_disabled` (custodial purchasing temporarily paused).
   */
  async purchase(params: PurchaseParams): Promise<Purchase> {
    const { overrides, rest } = this.split(params);
    const { idempotency_key, ...body } = rest;
    return this.http.data<Purchase>({
      ...overrides,
      method: "POST",
      path: `${BASE}/purchase`,
      body,
      idempotencyKey: idempotency_key ?? newIdempotencyKey(),
    });
  }

  /**
   * One purchase: status, on-chain linkage, and the revealed `items` once it
   * has settled.
   *
   * `GET /api/v1/mystery/purchase/{purchase_id}` · scope `packs:read`.
   *
   * Errors: `404 not_found` → `NotFoundError` (also when the purchase belongs
   * to another partner).
   */
  async getPurchase(id: number, overrides?: RequestOverrides): Promise<Purchase> {
    return this.http.data<Purchase>({
      ...(overrides ?? {}),
      method: "GET",
      path: `${BASE}/purchase/${encodeURIComponent(String(id))}`,
    });
  }

  /**
   * Poll {@link getPurchase} until the reveal settles, then resolve with the
   * finished purchase — so `items` is right there.
   *
   * Done: `FULFILLED` / `PARTIALLY_FULFILLED`. Failure: `FAILED` / `REFUNDED`,
   * which throw `TerminalStateError` with the purchase on `.resource`.
   * Running past `timeoutMs` (default 120 s) throws `PollTimeoutError`.
   *
   * Polls `GET /api/v1/mystery/purchase/{id}` · scope `packs:read`. On a
   * high-volume integration prefer the `purchase.fulfilled` webhook.
   */
  async waitForReveal(id: number, opts: PollOptions = {}): Promise<Purchase> {
    return poll<Purchase>(
      {
        label: `purchase ${id}`,
        fetch: () => this.getPurchase(id, opts.signal ? { signal: opts.signal } : undefined),
        isDone: (p) => p.status === "FULFILLED" || p.status === "PARTIALLY_FULFILLED",
        isFailed: (p) => (p.status === "FAILED" || p.status === "REFUNDED") && p.status,
      },
      opts,
    );
  }

  /**
   * Purchase history for this partner, newest first.
   *
   * `GET /api/v1/mystery/purchases` · scope `packs:read`. Filter with `status`
   * and/or an end-user identity.
   *
   * Errors: `400 invalid_status` (unknown status value).
   */
  async listPurchases(params?: ListPurchasesParams): Promise<OffsetPage<Purchase>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...filters } = rest;
    return this.offsetPage<Purchase>(
      { ...overrides, path: `${BASE}/purchases`, query: { ...filters } },
      "purchases",
      { limit, offset },
    );
  }

  /**
   * Everything delivered to one end user through this partner's fulfilled
   * purchases, newest first — the direct answer to "which cards does this user
   * own?", with the canonical `card_id` on every card.
   *
   * `GET /api/v1/mystery/collection` · scope `packs:read`. The end-user
   * identity is required.
   *
   * Returns a {@link CollectionPage}: an `OffsetPage<CollectionItem>` that also
   * carries the resolved `user`, so `page.user.wallet_address` tells you which
   * wallet each `still_owned` flag was computed against. `next()` returns a
   * `CollectionPage` too.
   *
   * Errors: `400 missing_user_identifier`, `400 invalid_wallet_address`.
   */
  async collection(params: CollectionParams): Promise<CollectionPage> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...identity } = rest;

    const fetchAt = async (at: number | undefined): Promise<CollectionPage> => {
      const res = await this.http.raw<
        Envelope<{ user: CollectionUser; items: CollectionItem[] }>
      >({
        ...overrides,
        method: "GET",
        path: `${BASE}/collection`,
        query: { ...identity, limit, offset: at },
      });
      const data = res.body.data;
      const items = data?.items ?? [];
      return new CollectionPage(
        data?.user ?? { external_user_id: null, wallet_address: null },
        items,
        res.body.pagination ?? { limit: limit ?? items.length, offset: at ?? 0, has_more: false },
        fetchAt,
      );
    };

    return fetchAt(offset);
  }

  /**
   * This key's volume: pulls by outcome, volume overall and per tier, and
   * buyback activity.
   *
   * `GET /api/v1/mystery/stats` · scope `packs:read`.
   */
  async stats(overrides?: RequestOverrides): Promise<PartnerStats> {
    return this.http.data<PartnerStats>({
      ...(overrides ?? {}),
      method: "GET",
      path: `${BASE}/stats`,
    });
  }

  /**
   * Non-custodial purchase, step 1: the unsigned approve + purchase calls for
   * the end user to send from their own wallet. CardOS never touches their
   * funds and nothing is created server-side.
   *
   * `POST /api/v1/mystery/purchase/prepare` · scope `packs:purchase`.
   *
   * Send `calls` in order and dispatch on `call.kind` (`erc20-approve`, then
   * `purchase`) — not on the description or the 4-byte selector, because an
   * account-abstraction wallet must send the approve as its own userop. Skip
   * the approve entirely when the wallet's allowance already covers
   * `max_price`. Then record the tx with {@link submit}.
   *
   * Errors: `400 invalid_tier` (unknown `tier_id`).
   */
  async prepare(params: PreparePurchaseParams): Promise<PurchasePrepareResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<PurchasePrepareResult>({
      ...overrides,
      method: "POST",
      path: `${BASE}/purchase/prepare`,
      body: { ...rest },
    });
  }

  /**
   * Non-custodial purchase, step 2: record the transaction the end user
   * broadcast so CardOS can link the reveal to it.
   *
   * `POST /api/v1/mystery/purchase/submit` → `202` · scope `packs:purchase`.
   *
   * Submit only once the tx is mined — it is verified on-chain before the
   * reveal is linked. Passing `request_id` from the receipt logs speeds that
   * up. The `202` body is the same purchase `getPurchase()` returns, `items`
   * included when the reveal already settled (an idempotent re-submit, or the
   * reveal simply beat you to it), so check `status` before scheduling a poll.
   *
   * Errors: `400` for a transaction hash that is missing, malformed, reverted
   * or not yet verifiable on-chain; `400 invalid_tier` for an unknown tier.
   */
  async submit(params: SubmitPurchaseParams): Promise<Purchase> {
    const { overrides, rest } = this.split(params);
    return this.http.data<Purchase>({
      ...overrides,
      method: "POST",
      path: `${BASE}/purchase/submit`,
      body: { ...rest },
    });
  }

  /**
   * A card's market value and what the pool would pay to buy it back.
   *
   * `GET /api/v1/mystery/price` · scope `read:catalog` · cached 60 s. Pass
   * exactly one of `card_id` or `token_id`; a token that resolves to a graded
   * slab is priced from the `(card, company, grade)` feed, never the raw card
   * value — `item_type` and `value_source` say what was actually priced.
   *
   * Errors: `400 invalid_price_query` (zero or both ids), `404 not_found`
   * (unknown card or token), `404 value_unknown` (the card exists but no market
   * price is available) — both `NotFoundError`.
   */
  async price(params: PriceParams): Promise<PriceQuote> {
    const { overrides, rest } = this.split(params);
    return this.http.data<PriceQuote>({
      ...overrides,
      method: "GET",
      path: `${BASE}/price`,
      query: { ...rest },
    });
  }
}
