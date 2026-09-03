/**
 * `cardos.cards` — the Card Data catalog's card endpoints.
 *
 * Every route here is `GET /api/v1/{game}/…`, scope `read:catalog`, metered at
 * **1 credit per request** whatever the response carries (so `include: "prices"`
 * on a page of 100 costs the same as without, and strictly less than 100 extra
 * calls). The routes the docs mark "not live yet" — card price history,
 * listings, population and Vision — return 404 today, so they are deliberately
 * absent from this SDK and will be added when they ship.
 *
 * `game` defaults to the client's (`new CardOS({ game: "onepiece" })`) and can
 * be overridden on any call with `params.game`.
 */

import type { HttpRequest, Query } from "../http.js";
import { NumberedPage } from "../pagination.js";
import type {
  Card,
  CardGetParams,
  CardPrices,
  CardPrintingsParams,
  CardSearchParams,
  CatalogRequestParams,
} from "../types/cards.js";
import type { CatalogEnvelope, GameId, NumberedPagination } from "../types/common.js";
import { Resource } from "./base.js";

/** Base path for one game's catalog: `/api/v1/pokemon`, `/api/v1/onepiece`, … */
export function catalogBase(game: GameId): string {
  return `/api/v1/${game}`;
}

/** Path-safe id — catalog ids carry variant suffixes and the odd stray character. */
export function catalogId(id: string): string {
  return encodeURIComponent(id);
}

/** The query params every catalog search shares. `undefined` entries are dropped by the client. */
export function catalogSearchQuery(params: {
  q?: string;
  language?: unknown;
  orderBy?: string;
  distinct?: string;
  select?: string[] | string;
  include?: string;
}): Query {
  return {
    q: params.q,
    language: params.language as Query[string],
    orderBy: params.orderBy,
    distinct: params.distinct,
    select: params.select,
    include: params.include,
  };
}

export class CardsResource extends Resource {
  /**
   * Search the card catalog.
   *
   * `GET /api/v1/{game}/cards` — scope `read:catalog`, 1 credit.
   *
   * Returns a `NumberedPage<Card>`: `page.items`, `page.totalCount`,
   * `await page.next()` for the next page, `for await (const card of page)` to
   * walk them all, and `await page.all()` to drain the rest into one array
   * (mind the `page × page_size ≤ 10 000` depth cap — narrow with `q` rather
   * than paging deeper).
   *
   * **The `q` grammar** is Lucene-flavoured. Terms are `field:value`, matched
   * case-insensitively, and text fields match on substrings — a bare term with
   * no field matches the name. Several terms are ANDed; `OR` (uppercase) and
   * parentheses group alternatives, and a leading `-` excludes. `!` before a
   * field forces a whole-value match (`!name:pikachu` is not "Pikachu V").
   * Quote any value containing spaces. `*` is a wildcard anywhere but the start
   * of a value, at most 3 per value and with at least 2 literal characters.
   * Ranges are `[low TO high]` inclusive or `{low TO high}` exclusive, with `*`
   * as an open end.
   *
   * Caps: 512 characters, 20 terms, 5 levels of nesting, and `orderBy`'s 3
   * keys — all four are a 400 `query_too_complex`. A generated filter hits them
   * long before a hand-typed one does, so count terms as you assemble and split
   * a wide filter into several narrow calls. An unknown field, a leading
   * wildcard and an unquoted space are each a 400 rather than an empty page,
   * and an unknown field's error names a suggestion.
   *
   * ```ts
   * // Pokémon: big non-water Charizards, priced, newest set first.
   * await cardos.cards.search({
   *   q: "name:char* -types:water hp:[150 TO *]",
   *   orderBy: "-release_date",
   *   include: "prices",
   * });
   *
   * // One Piece: a cheap black Character pool, one row per card not per printing.
   * await cardos.cards.search({
   *   game: "onepiece",
   *   q: 'colors:Black cost:[1 TO 3] type:Character',
   *   distinct: "code",
   * });
   * ```
   *
   * `language` defaults to `en` (every card exists once per printed language,
   * so an unfiltered list interleaves catalogs); pass `"all"` or a code. A
   * `language:`, `id:` or `expansion.id:` term in `q` already pins it, so the
   * default steps aside — the value the server applied comes back as
   * `page.language`.
   *
   * Errors: `invalid_query` / `query_too_complex` (400, `details.position`
   * points at the offending character), `invalid_pagination`,
   * `invalid_language`, `invalid_distinct` — all `ValidationError`.
   */
  async search(params: CardSearchParams = {}): Promise<NumberedPage<Card>> {
    const { overrides, rest } = this.split(params);
    return this.numberedPage<Card>(
      {
        ...overrides,
        path: `${catalogBase(rest.game ?? this.ctx.game)}/cards`,
        query: catalogSearchQuery(rest),
      },
      rest,
    );
  }

  /**
   * Fetch one card by id — the cheapest way to hydrate a card you already know.
   *
   * `GET /api/v1/{game}/cards/{id}` — scope `read:catalog`, 1 credit.
   *
   * Ids match case-insensitively (`OPPR-681242` finds `oppr-681242`) and the
   * response always carries the stored spelling. Add `include: "prices"` for
   * the embedded pricing object.
   *
   * Errors: `not_found` (404 `NotFoundError`) — a Pokémon id on `/onepiece` is
   * "not found", never leaked.
   */
  async get(id: string, params: CardGetParams = {}): Promise<Card> {
    const { overrides, rest } = this.split(params);
    return this.http.data<Card>({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/cards/${catalogId(id)}`,
      query: { include: rest.include, select: rest.select },
    });
  }

  /**
   * Every printing that shares this card's code — the base art, each alternate
   * and special art, in every language the code was printed in.
   *
   * `GET /api/v1/{game}/cards/{id}/printings` — scope `read:catalog`, 1 credit.
   *
   * Prefer this over guessing at id suffixes: each printing is a full `Card`
   * with its own id, images and (with `include: "prices"`) its own price, and
   * on One Piece the spread across one code reaches 1000×. `variants[]` on a
   * card describes that one row's finish, not its siblings — this is how you
   * find the siblings.
   *
   * Order is canonical and independent of which printing you asked by: the
   * anchor's language first, then the rest alphabetically, then id — so
   * `EB01-001vaa` returns the same page, in the same order, as `EB01-001`.
   *
   * `language` is honoured but NOT defaulted here (a code spans languages by
   * definition). The result is a **single, terminal** `NumberedPage<Card>`
   * capped at 50 rows: `totalCount` is the true family size even when the cap
   * truncated the page, so `totalCount > items.length` means there are more
   * printings than the server will hand back — there is no page 2 to fetch, and
   * `next()` / `all()` will not find one.
   *
   * Errors: `not_found` (404 `NotFoundError`).
   */
  async printings(id: string, params: CardPrintingsParams = {}): Promise<NumberedPage<Card>> {
    const { overrides, rest } = this.split(params);
    return this.cappedPage({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/cards/${catalogId(id)}/printings`,
      query: {
        language: rest.language as Query[string],
        include: rest.include,
        select: rest.select,
      },
    });
  }

  /**
   * Full pricing for one card: the raw condition ladder plus every graded tier
   * we can value, with sold counts, confidence and bands.
   *
   * `GET /api/v1/{game}/cards/{id}/prices` — scope `read:catalog`, 1 credit.
   *
   * Returns `{ card_id, pricing }`. Prefer it over `include: "prices"` when
   * pricing is the point of the call — it returns strictly more detail (graded
   * `band`, `last_sold_at`) for the same credit. Amounts are USD **numbers**,
   * not strings, and `pricing.market` is `null` when we hold no price.
   *
   * Errors: `not_found` (404 `NotFoundError`).
   */
  async prices(id: string, params: CatalogRequestParams = {}): Promise<CardPrices> {
    const { overrides, rest } = this.split(params);
    return this.http.data<CardPrices>({
      ...overrides,
      method: "GET",
      path: `${catalogBase(rest.game ?? this.ctx.game)}/cards/${catalogId(id)}/prices`,
    });
  }

  /**
   * One page from an endpoint that caps its result instead of paginating it
   * (`/printings`): the server ignores `page` there, so the page is terminal —
   * `next()` yields an empty page rather than re-fetching the same rows for
   * ever, and iteration stops after these items.
   */
  private async cappedPage(req: HttpRequest): Promise<NumberedPage<Card>> {
    const body = await this.http.request<CatalogEnvelope<Card[]>>(req);
    const items = body.data ?? [];
    const pagination: NumberedPagination = {
      page: body.page ?? 1,
      page_size: body.page_size ?? items.length,
      total_count: body.total_count ?? items.length,
      language: body.language,
    };
    const noMorePages = async (page: number): Promise<NumberedPage<Card>> =>
      new NumberedPage<Card>([], { ...pagination, page }, noMorePages);
    return new NumberedPage<Card>(items, pagination, noMorePages);
  }
}
