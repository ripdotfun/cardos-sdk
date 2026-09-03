/**
 * `cardos.expansions` — the Card Data catalog's expansion (set) endpoints.
 *
 * `GET /api/v1/{game}/expansions…`, scope `read:catalog`, 1 credit per request.
 * `game` defaults to the client's and is overridable per call via `params.game`.
 */

import { NumberedPage } from "../pagination.js";
import type {
  Card,
  CardSearchParams,
  Expansion,
  ExpansionGetParams,
  ExpansionSearchParams,
} from "../types/cards.js";
import { Resource } from "./base.js";
import { catalogBase, catalogId, catalogSearchQuery } from "./cards.js";

export class ExpansionsResource extends Resource {
  /**
   * List or filter expansions.
   *
   * `GET /api/v1/{game}/expansions` — scope `read:catalog`, 1 credit.
   *
   * Returns a `NumberedPage<Expansion>` — `page.items`, `page.totalCount`,
   * `await page.next()`, `await page.all()` to drain the rest. Do paginate:
   * there are more than 100 One Piece expansions, so a single unpaginated call
   * silently omits the newest sets.
   *
   * `q` takes the same Lucene-flavoured grammar as `cards.search`, over the
   * expansion fields — e.g. `q: "series_id:sv"`, or
   * `q: "release_date:[2024-01-01 TO *]"` with `orderBy: "-release_date"`.
   * `orderBy` sorts on `name`, `release_date` and `id`. `include` is not
   * supported here. `language` defaults to `en`; the applied value comes back
   * as `page.language`.
   *
   * Errors: `invalid_query`, `query_too_complex`, `invalid_pagination`,
   * `invalid_language` — all 400 `ValidationError`.
   */
  async search(params: ExpansionSearchParams = {}): Promise<NumberedPage<Expansion>> {
    const { overrides, rest } = this.split(params);
    return this.numberedPage<Expansion>(
      {
        ...overrides,
        path: `${catalogBase(rest.game ?? this.ctx.game)}/expansions`,
        query: catalogSearchQuery(rest),
      },
      rest,
    );
  }

  /**
   * Fetch one expansion by id — name, series, card counts, release date and
   * artwork, to render a set header before paging its cards.
   *
   * `GET /api/v1/{game}/expansions/{id}` — scope `read:catalog`, 1 credit.
   *
   * The expansion endpoints do not list every set — the promo, tin and UPC sets
   * are absent — so an `expansion.id` read off a card or sealed product can 404
   * on this call while the nested object beside it is fully populated. Read it
   * from there rather than re-fetching.
   *
   * Errors: `not_found` (404 `NotFoundError`).
   */
  async get(id: string, params: ExpansionGetParams = {}): Promise<Expansion> {
    const { overrides, rest } = this.split(params);
    return this.http.data<Expansion>({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/expansions/${catalogId(id)}`,
      query: { select: rest.select },
    });
  }

  /**
   * Page through one expansion's cards.
   *
   * `GET /api/v1/{game}/expansions/{id}/cards` — scope `read:catalog`, 1 credit.
   *
   * Equivalent to `cards.search({ q: "expansion.id:{id}" })` but scoped by
   * path, so the query cannot accidentally widen. Takes the same `q`,
   * `orderBy`, `distinct`, `select`, `include` and paging params, and returns
   * the same `NumberedPage<Card>`. Each card carries only its home `expansion`,
   * so a printing that also shipped in another set is listed under one of them
   * rather than both.
   *
   * `language` is honoured but NOT defaulted here — an expansion id already
   * names a language (`EB01` vs `EB01_ja`), so an English default would empty
   * every Japanese set.
   *
   * Errors: `not_found` (404) for an unknown expansion or one belonging to
   * another game; `invalid_query`, `query_too_complex`, `invalid_pagination`,
   * `invalid_language`, `invalid_distinct` (400).
   */
  async cards(id: string, params: CardSearchParams = {}): Promise<NumberedPage<Card>> {
    const { overrides, rest } = this.split(params);
    return this.numberedPage<Card>(
      {
        ...overrides,
        path: `${catalogBase(rest.game ?? this.ctx.game)}/expansions/${catalogId(id)}/cards`,
        query: catalogSearchQuery(rest),
      },
      rest,
    );
  }
}
