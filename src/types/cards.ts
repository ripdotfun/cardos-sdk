/**
 * Card Data API types — cards, expansions, sealed product and their pricing.
 *
 * Three house rules run through all of them:
 *
 * 1. **Absent values are omitted, never null.** A missing key means "we don't
 *    hold this", not zero and not empty — hence the liberal `?`. The keys that
 *    come back nullable rather than absent are the ones the API always returns
 *    even with no value: `Card.tcgplayer_id`, `CardPricing.market`,
 *    `SealedPricing.market` and the graded `low` / `high` bands.
 * 2. **Card Data money is a JSON number, not a string.** This is the one
 *    exception to the SDK-wide "money is a string" rule: the catalog returns
 *    `market: 12.5`, `price: 8.42` — plain amounts in the payload's `currency`
 *    — so they are typed as `number`. The gacha / wallet / sell-back money
 *    fields stay `UsdcString`.
 * 3. **`select=` trims the response.** It filters each object down to the named
 *    top-level fields (plus `id`), so when you pass `select` any field except
 *    `id` can be missing regardless of what these types say.
 *
 * Optional members noted as *present when available* are part of the documented
 * response but are only sent for objects we hold that data for — read them
 * defensively rather than asserting them.
 */

import type { GameId, NumberedPageParams, RequestOverrides } from "./common.js";

/* ── Shared query vocabulary ─────────────────────────────────────────────── */

/**
 * A catalog language code as the API takes and reports it: `en`, `ja`, `zh`,
 * plus `zh-Hans` / `zh-Hant` where Chinese splits. List endpoints default to
 * `en`; pass `"all"` for every language.
 */
export type CatalogLanguage = "en" | "ja" | "zh" | "zh-Hans" | "zh-Hant" | (string & {});

/** `language=` filter: one code, a comma list (pass an array), or `"all"`. */
export type CatalogLanguageFilter = CatalogLanguage | CatalogLanguage[] | "all";

/** `include=` values the card and sealed endpoints accept. Expansions accept none. */
export type CatalogInclude = "prices";

/**
 * `orderBy=` — a comma list of sort keys, `-` prefixed for DESC
 * (`"-release_date"`, `"rarity,-raw_price"`). Max 3 keys.
 *
 * Cards sort on `name`, `number`, `rarity`, `raw_price` / `market_price`,
 * `release_date` (alias `expansion.release_date`), `expansion.id`, `id` — plus
 * `hp` on Pokémon and `cost`, `power`, `counter`, `life` on One Piece.
 * Expansions sort on `name`, `release_date`, `id`. Sealed sorts on `name`,
 * `price` (not `raw_price` — a product has no condition to qualify),
 * `release_date`, `id`.
 *
 * Values missing the sort key come LAST in both directions, and every sort
 * carries a unique `id` tiebreak, so walking a sorted result set can neither
 * skip nor repeat a row.
 */
export type CatalogOrderBy = string;

/** Every Card Data call may override the game and the usual per-request knobs. */
export interface CatalogRequestParams extends RequestOverrides {
  /** Override the client-wide default game (`new CardOS({ game })`) for this call. */
  game?: GameId;
}

/** Params shared by every Card Data list endpoint. */
export interface CatalogListParams extends CatalogRequestParams, NumberedPageParams {
  /**
   * Comma list of top-level fields to keep — `id` is always returned. Pass an
   * array; the client joins it. Trims the payload, never the credit cost.
   */
  select?: string[] | string;
}

/* ── Images & variants ───────────────────────────────────────────────────── */

/**
 * One rendition of a card or product. `type` is always `"front"` and `medium`
 * is an alias of `large` (only two sizes are published). On cards whose source
 * supplied a single rendition `small` is an alias too, so compare the two URLs
 * before assuming `small` is the cheap one — where they differ it is roughly
 * 6× smaller. Use `small` for grids and `large` for detail views.
 */
export interface CardImage {
  type: string;
  small: string;
  medium: string;
  large: string;
}

/**
 * The finish of one printing — `normal`, `holofoil`, `reverseHolofoil`,
 * `firstEdition`, a stamp variant, or a One Piece variant name. Each card row
 * is its own printing, so `variants` always has exactly one self-describing
 * entry; use `cards.printings(id)` to find the siblings.
 */
export interface CardVariant {
  name: string;
  images: CardImage[];
}

/* ── Game-specific card sub-objects ──────────────────────────────────────── */

/** A printed ability (Pokémon). */
export interface CardAbility {
  type: string;
  name: string;
  text: string;
}

/** A printed attack (Pokémon). `converted_energy_cost` is `cost.length`. */
export interface CardAttack {
  cost: string[];
  converted_energy_cost: number;
  name: string;
  text?: string;
  /** A string, not a number; omitted when the attack does no damage. */
  damage?: string;
}

/** A weakness / resistance pair, e.g. `{ type: "Fire", value: "×2" }`. */
export interface CardTypeValue {
  type: string;
  value: string;
}

/* ── Expansions ──────────────────────────────────────────────────────────── */

/**
 * An expansion (set). `GET /api/v1/{game}/expansions/{id}` returns this, and
 * the same object is returned inline on every card and sealed product.
 */
export interface Expansion {
  id: string;
  name: string;
  /** Total cards including secret rares. */
  total: number;
  /** Canonicalised name, e.g. `"English"`, `"Japanese"`. */
  language: string;
  /** ISO code, e.g. `"en"`, `"ja"`, `"zh-Hant"`. */
  language_code: string;
  /** Series name, when the set belongs to one. */
  series?: string;
  /** Printed set code (`EB01` for both `EB01` and `EB01_ja`). */
  code?: string;
  /** The printed card count, when it differs from `total`. */
  printed_total?: number;
  /** `YYYY/MM/DD`. */
  release_date?: string;
  logo?: string;
  symbol?: string;
  /** English name of a non-English set. */
  translation?: { en?: { name: string } };
}

/**
 * The expansion returned inline on a `Card` / `SealedProduct`. Identical to
 * `Expansion` — aliased so the nesting reads clearly.
 *
 * It is complete even for the promo, tin and UPC sets `/expansions` does not
 * list, so `expansion.id` can 404 on `expansions.get()` while the object beside
 * it is fully populated. Read it from here rather than re-fetching.
 */
export type CardExpansionRef = Expansion;

/* ── Pricing ─────────────────────────────────────────────────────────────── */

/** Signed change over a window. `percent` is a plain number, e.g. `-4.2`. */
export interface CardPriceTrend {
  direction: "up" | "down" | "flat";
  percent: number;
}

/**
 * One rung of the raw condition ladder — `NM`, `LP`, `MP`, `HP`, `DMG` on a
 * card, the single `sealed` rung on a sealed product. Amounts are numbers in
 * the payload's `currency`.
 *
 * Two fields only. The value band and the comp count live on the graded
 * entries, not here.
 */
export interface CardPricingCondition {
  condition: string;
  price: number;
}

/** Aggregate sold-comp band for a graded bucket. `cards.prices()` only. */
export interface CardGradedBand {
  median: number | null;
  recent_median: number | null;
  p10: number | null;
  p90: number | null;
  count: number;
}

/**
 * A reconciled graded value for one company + grade (e.g. PSA 10) — our price
 * feed blended with real recent sales. `value_kind` says which side won:
 * `sold` (backed by recent sales), `blended` (feed plus a few sales), or
 * `feed` (estimate only), and `confidence` says how much sold-comp evidence is
 * behind it.
 */
export interface CardGradedPrice {
  /** `PSA`, `BGS`, `CGC`, … */
  company: string;
  grade: string;
  value: number;
  /** Low end of the value band (p10 of comps, or a ±band around the estimate). */
  low: number | null;
  /** High end of the value band (p90 of comps, or a ±band around the estimate). */
  high: number | null;
  confidence: "low" | "med" | "high";
  value_kind: "sold" | "blended" | "feed";
  /** Recent (≤ 90d) sold comps backing the value. */
  sold_count: number;
  /** Sold momentum, recent median against prior median. Present when available. */
  trend?: CardPriceTrend;
  /** ISO-8601 timestamp of the most recent comp. `cards.prices()` only. */
  last_sold_at?: string;
  /** Aggregate sold band. `cards.prices()` only. */
  band?: CardGradedBand;
}

/**
 * A card's pricing object. Present inline on a `Card` with `include: "prices"`
 * — and then always present, even for a card we hold nothing for: `market`
 * comes back `null` and the two arrays empty rather than the key being dropped.
 * Also the whole payload of `cards.prices(id)`, which returns strictly more
 * (graded `band` / `last_sold_at`) for the same credit.
 */
export interface CardPricing {
  /** ISO currency of every amount in the payload. Always `"USD"` today. */
  currency: string;
  /** Ungraded market value, or `null` when we hold no price for the card. */
  market: number | null;
  /** When the market value was last recomputed (ISO-8601). */
  market_updated_at?: string;
  /** `true` when the sales window behind `market` is thin — treat as indicative. */
  is_stale: boolean;
  /**
   * The trailing week, and the only window a card carries — there is no
   * `trend_30d` or `trend_90d`. Omitted when there is no move to report.
   */
  trend_7d?: CardPriceTrend;
  /**
   * The raw ladder for this card's variant. Empty when we hold no
   * per-condition data for the card, so read it with `?? []`.
   */
  conditions?: CardPricingCondition[];
  /** Reconciled value per grading company + grade. */
  graded: CardGradedPrice[];
}

/** `GET /api/v1/{game}/cards/{id}/prices` → `{ card_id, pricing }`. */
export interface CardPrices {
  /** The id in its stored spelling, which may differ in case from the one you asked by. */
  card_id: string;
  pricing: CardPricing;
}

/* ── Card ────────────────────────────────────────────────────────────────── */

/**
 * One card printing. Every game-specific field is optional — Pokémon rows carry
 * `supertype` / `types` / `hp`, One Piece rows carry `type` / `cost` / `power` /
 * `colors` / `counter` / `life` / `block` instead (the overloaded
 * `supertype` / `hp` / `types` keys are suppressed there), and Azuki reuses the
 * Pokémon-shaped keys for its own concepts: `supertype` is its Card Type,
 * `types` a one-element Element array, and `hp` its Health.
 *
 * Values printed on the card that the API does not carry — `retreat_cost`,
 * `evolves_from`, `level`, `flavor_text`, `regulation_mark`,
 * `national_pokedex_numbers` on Pokémon, and Azuki's IKZ cost, Attack, Gate
 * power and rules text — are absent from the response rather than returned
 * empty, so they are absent from this type entirely. Each game's reference page
 * lists its own gaps.
 */
export interface Card {
  id: string;
  name: string;
  /** Card number within the set. */
  number: string;
  /** Number as printed on the card. */
  printed_number?: string;
  images: CardImage[];
  expansion: CardExpansionRef;
  /** Canonicalised language name, e.g. `"English"`. */
  language: string;
  /** ISO code, e.g. `"en"`. */
  language_code: string;
  /** TCGplayer product id for cross-referencing, or `null` when we have none. */
  tcgplayer_id: string | null;
  /** Always exactly one entry describing THIS printing's finish. */
  variants: CardVariant[];

  rarity?: string;
  artist?: string;

  // Pokémon / shared
  /** `Pokémon`, `Trainer`, `Energy`. Suppressed on One Piece. */
  supertype?: string;
  /** Classification (Basic, Stage 1, VMAX, Supporter…); One Piece traits. */
  subtypes?: string[];
  /** Energy types. Suppressed on One Piece — read `colors` there. */
  types?: string[];
  /** Hit points as a string, only when > 0. Suppressed on One Piece — read `power`. */
  hp?: string;
  abilities?: CardAbility[];
  attacks?: CardAttack[];
  weaknesses?: CardTypeValue[];
  resistances?: CardTypeValue[];

  // One Piece
  /** `Leader`, `Character`, `Event`, `Stage`, `DON!!`. Replaces `supertype`. */
  type?: string;
  /** Play cost, as a string. */
  cost?: string;
  /** Battle power, as a string. Replaces `hp`. */
  power?: string;
  /** `Slash`, `Strike`, `Ranged`, `Special`, `Wisdom`; duals join with `/`. */
  attribute?: string;
  /** `Red`, `Green`, `Blue`, `Purple`, `Black`, `Yellow`. Replaces `types`. */
  colors?: string[];
  /** Effect lines, one per printed paragraph, markup-free. */
  rules?: string[];
  /**
   * Printed Block icon verbatim from Bandai: `1`–`5` or `X`; multiples join
   * with `/`, and absent is not the same answer as `X`. It is what the card
   * shows, not what is currently legal — blocks get reassigned after print
   * without the artwork changing — so take format legality from the official
   * regulation list rather than from this field.
   */
  block?: string;
  /** Printed Counter value on Characters. Partial coverage — absent ≠ zero. */
  counter?: string;
  /** Leader Life total. Leaders only, partial coverage. */
  life?: string;

  /**
   * Present only when the request asked for `include: "prices"`, and then for
   * every card: one we hold nothing for still gets the object, with
   * `market: null` and empty arrays. Typed nullable because the best-practices
   * guide tells integrators to code for `pricing: null` — check the object
   * before reaching into it either way.
   */
  pricing?: CardPricing | null;
}

/* ── Sealed product ──────────────────────────────────────────────────────── */

/**
 * The closed `product_type` vocabulary. There is deliberately no
 * `starter_deck` — decks are stored as `other` and nothing separates them
 * reliably, so filtering for one is a 400 `invalid_value`, never rows.
 */
export const SEALED_PRODUCT_TYPES = [
  "booster_pack",
  "sleeved_pack",
  "booster_box",
  "booster_pack_case",
  "bundle",
  "pack_art_bundle",
  "blister_pack",
  "three_pack_blister_pack",
  "elite_trainer_box",
  "ultra_premium_collection",
  "collection_box",
  "special_box",
  "tin",
  "other",
] as const;

/** One of {@link SEALED_PRODUCT_TYPES}. */
export type SealedProductType = (typeof SEALED_PRODUCT_TYPES)[number];

/** One point of a sealed product's trailing price series. */
export interface SealedPricePoint {
  /** ISO-8601 instant. */
  date: string;
  price: number;
  /** Where the point came from, e.g. `tcgplayer`. */
  source: string;
}

/**
 * A sealed product's pricing. Deliberately unlike `CardPricing`: sealed goods
 * are not graded, so there is no `graded` block, and the ladder has exactly one
 * rung, `sealed` — factory-sealed is the only state we price, so there is no
 * `opened` value to compare it against.
 */
export interface SealedPricing {
  /** ISO currency of every amount in the payload. Always `"USD"` today. */
  currency: "USD";
  /**
   * Market value for a factory-sealed copy, or `null` where we hold none —
   * including every MSRP-priced product (the Azuki catalog today), whose list
   * price surfaces as `SealedProduct.msrp` instead. The two are never both
   * present, so a "vs MSRP" premium is not computable for those.
   */
  market: number | null;
  /** When that value was last recomputed (ISO-8601). */
  updated_at?: string;
  is_on_sale: boolean;
  /** A live sale price, present only when there is one to report. */
  sale_price?: number;
  /**
   * Signed percentage change over the trailing week. Sealed carries this one
   * window only — there is no 30- or 90-day figure here.
   */
  trend_7d?: CardPriceTrend;
  /** `sealed.prices()` only. Exactly one rung, `sealed`, priced at `market`. */
  conditions?: CardPricingCondition[];
  /**
   * `sealed.prices()` only, capped per request. This is the whole of the sealed
   * time series — there is no separate history route.
   */
  history?: SealedPricePoint[];
}

/** `GET /api/v1/{game}/sealed/{id}/prices` → `{ product_id, pricing }`. */
export interface SealedPrices {
  /** The id in its stored spelling. */
  product_id: string;
  pricing: SealedPricing;
}

/**
 * A sealed product — booster boxes, ETBs, bundles, blisters, tins. `language`
 * and `release_date` are the EXPANSION's values: a product ships in its set's
 * language, on its set's street date, so every product in a set reports the
 * same day and a later reprint still reports the original one.
 */
export interface SealedProduct {
  id: string;
  name: string;
  expansion: CardExpansionRef;
  language: string;
  language_code: string;
  images: CardImage[];
  /** Omitted on the few products we hold no type for. */
  product_type?: SealedProductType | (string & {});
  /** The expansion's street date, `YYYY/MM/DD`. */
  release_date?: string;
  /**
   * Manufacturer's list price, present only where MSRP is what we price the
   * product at rather than the market — the Azuki catalog today. It is not a
   * second opinion sitting beside `pricing.market`.
   */
  msrp?: number;
  /** Configuration, when known. */
  pack_count?: number;
  /** Configuration, when known. */
  cards_per_pack?: number;
  /** TCGplayer product id for cross-referencing, when we have one. */
  tcgplayer_id?: string;
  /** Present only with `include: "prices"` (no `conditions` / `history` there). */
  pricing?: SealedPricing | null;
}

/* ── Params ──────────────────────────────────────────────────────────────── */

/** `cards.search()` / `expansions.cards()`. */
export interface CardSearchParams extends CatalogListParams {
  /** Lucene-style query — see the method JSDoc for the grammar. */
  q?: string;
  /** Defaults to `en` on search; pass `"all"` for every printed language. */
  language?: CatalogLanguageFilter;
  orderBy?: CatalogOrderBy;
  /**
   * `"code"` returns one row per card rather than one per printing, and makes
   * `total_count` count cards. The row kept is the base printing, and it is
   * picked before your filters — so a filter that varies BETWEEN printings of a
   * code (`rarity`, `raw_price`, `is_holo`, `variant`) can match only a parallel
   * and still return nothing. Every gameplay field is shared across a code's
   * printings, so deck-building queries are unaffected.
   */
  distinct?: "code";
  /** `"prices"` embeds `pricing` on every card. No surcharge. */
  include?: CatalogInclude;
}

/** `cards.get()`. */
export interface CardGetParams extends CatalogRequestParams {
  include?: CatalogInclude;
  select?: string[] | string;
}

/** `cards.printings()`. */
export interface CardPrintingsParams extends CatalogRequestParams {
  /** NOT defaulted here — a code spans languages by definition. */
  language?: CatalogLanguageFilter;
  include?: CatalogInclude;
  select?: string[] | string;
}

/** `expansions.search()`. */
export interface ExpansionSearchParams extends CatalogListParams {
  /**
   * Expansion field set only — `name` (the default field), `id`, `series_id`,
   * `language`, `release_date`, `card_count.total`, `card_count.official`.
   * e.g. `series_id:sv`, `release_date:[2024-01-01 TO *]`.
   */
  q?: string;
  language?: CatalogLanguageFilter;
  /** `name`, `release_date`, `id`. */
  orderBy?: CatalogOrderBy;
}

/** `expansions.get()` — the single read only trims fields. */
export interface ExpansionGetParams extends CatalogRequestParams {
  select?: string[] | string;
}

/** `sealed.search()`. */
export interface SealedSearchParams extends CatalogListParams {
  /** Sealed field set only — `name`, `id`, `product_type`, `expansion.*`, `language`, `price`, `is_on_sale`. */
  q?: string;
  language?: CatalogLanguageFilter;
  /** `name`, `price`, `release_date`, `id`. */
  orderBy?: CatalogOrderBy;
  /** Shorthand for `q=product_type:…`. An unknown value is a 400 `invalid_value`, never an empty page. */
  product_type?: SealedProductType | (string & {}) | Array<SealedProductType | (string & {})>;
  include?: CatalogInclude;
}

/** `sealed.get()`. */
export interface SealedGetParams extends CatalogRequestParams {
  include?: CatalogInclude;
  select?: string[] | string;
}
