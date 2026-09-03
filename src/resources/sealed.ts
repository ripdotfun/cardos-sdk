/**
 * `cardos.sealed` — the Card Data catalog's sealed-product endpoints (booster
 * packs and boxes, elite trainer boxes, bundles, blisters, tins, collection
 * boxes).
 *
 * `GET /api/v1/{game}/sealed…`, scope `read:catalog`, 1 credit per request.
 * `game` defaults to the client's and is overridable per call via `params.game`.
 */

import type { Query } from "../http.js";
import { NumberedPage } from "../pagination.js";
import type {
  CatalogRequestParams,
  SealedGetParams,
  SealedPrices,
  SealedProduct,
  SealedSearchParams,
} from "../types/cards.js";
import { Resource } from "./base.js";
import { catalogBase, catalogId, catalogSearchQuery } from "./cards.js";

export class SealedResource extends Resource {
  /**
   * Search sealed product.
   *
   * `GET /api/v1/{game}/sealed` — scope `read:catalog`, 1 credit.
   *
   * Returns a `NumberedPage<SealedProduct>` — `page.items`, `page.totalCount`,
   * `await page.next()`, `await page.all()` to drain the rest.
   *
   * Same `q` grammar as `cards.search`, over the much smaller sealed field set:
   * `name` (the default field, so a bare term matches the name), `id`,
   * `product_type`, `expansion.id`, `expansion.name`, `expansion.release_date`,
   * `language`, `price`, `is_on_sale`. Card-only fields (`rarity`, `hp`,
   * `colors`, …) are a 400 here. There is no `distinct` — a product is one row,
   * not a family of printings.
   *
   * ```ts
   * // Every Scarlet & Violet 151 booster box, priced.
   * await cardos.sealed.search({
   *   q: "expansion.id:sv3pt5",
   *   product_type: "booster_box",
   *   include: "prices",
   * });
   *
   * // The most expensive sealed One Piece product we track.
   * await cardos.sealed.search({
   *   game: "onepiece",
   *   q: "price:[100 TO *]",
   *   orderBy: "-price",
   *   page_size: 10,
   * });
   * ```
   *
   * `product_type` is shorthand for `q=product_type:…` and takes the closed
   * vocabulary in `SEALED_PRODUCT_TYPES` (pass an array for several). An
   * unrecognised value is a 400 `invalid_value`, never an empty page —
   * `starter_deck` is the one people try, and it has never existed. `language`
   * defaults to `en`; `orderBy` sorts on `name`, `price`, `release_date`, `id`.
   *
   * Errors: `invalid_value`, `invalid_query`, `query_too_complex`,
   * `invalid_pagination`, `invalid_language` — all 400 `ValidationError`.
   */
  async search(params: SealedSearchParams = {}): Promise<NumberedPage<SealedProduct>> {
    const { overrides, rest } = this.split(params);
    return this.numberedPage<SealedProduct>(
      {
        ...overrides,
        path: `${catalogBase(rest.game ?? this.ctx.game)}/sealed`,
        query: {
          ...catalogSearchQuery(rest),
          product_type: rest.product_type as Query[string],
        },
      },
      rest,
    );
  }

  /**
   * Fetch one sealed product by id: its configuration (pack count, cards per
   * pack), its expansion in full, and MSRP where MSRP is what we price it at.
   *
   * `GET /api/v1/{game}/sealed/{id}` — scope `read:catalog`, 1 credit.
   *
   * Ids match case-insensitively and the response carries the stored spelling.
   * Add `include: "prices"` for the inline pricing object (market, sale price,
   * 7-day trend — no condition ladder or history; those come from
   * `sealed.prices`). There is no `language` handling: an id already names one
   * product.
   *
   * Errors: `not_found` (404 `NotFoundError`).
   */
  async get(id: string, params: SealedGetParams = {}): Promise<SealedProduct> {
    const { overrides, rest } = this.split(params);
    return this.http.data<SealedProduct>({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/sealed/${catalogId(id)}`,
      query: { include: rest.include, select: rest.select },
    });
  }

  /**
   * Market pricing for one sealed product: current value, 7-day trend, any live
   * sale price, and the trailing history behind it.
   *
   * `GET /api/v1/{game}/sealed/{id}/prices` — scope `read:catalog`, 1 credit.
   *
   * Returns `{ product_id, pricing }` — the sealed twin of a card's
   * `{ card_id, pricing }`. Where a card carries a five-rung ladder and a
   * graded block, sealed carries exactly one rung, `sealed`: factory-sealed is
   * the only state we price, so there is no `opened` value and no graded tier.
   * `pricing.history` is the whole of the sealed time series — there is no
   * history route. Amounts are USD **numbers**; `market` is `null` for an
   * MSRP-priced product (the whole Azuki catalog), whose list price is
   * `SealedProduct.msrp` instead.
   *
   * Errors: `not_found` (404 `NotFoundError`).
   */
  async prices(id: string, params: CatalogRequestParams = {}): Promise<SealedPrices> {
    const { overrides, rest } = this.split(params);
    return this.http.data<SealedPrices>({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/sealed/${catalogId(id)}/prices`,
    });
  }
}
