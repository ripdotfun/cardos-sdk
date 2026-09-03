import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError, type Card } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

/** A realistic (trimmed) card row as the catalog returns it. */
function card(id: string, extra: Partial<Card> = {}): Card {
  const images = [
    {
      type: "front",
      small: `https://cdn.rip.fun/${id}-sm.png`,
      medium: `https://cdn.rip.fun/${id}.png`,
      large: `https://cdn.rip.fun/${id}.png`,
    },
  ];
  return {
    id,
    name: "Charizard ex",
    number: "223",
    printed_number: "223",
    rarity: "Special Illustration Rare",
    artist: "Ryuta Fuse",
    supertype: "Pokémon",
    subtypes: ["Basic", "ex"],
    types: ["Fire"],
    hp: "330",
    images,
    expansion: {
      id: "sv3pt5",
      name: "151",
      total: 207,
      printed_total: 165,
      series: "Scarlet & Violet",
      code: "MEW",
      language: "English",
      language_code: "en",
      release_date: "2023/09/22",
    },
    language: "English",
    language_code: "en",
    tcgplayer_id: "517800",
    variants: [{ name: "holofoil", images }],
    ...extra,
  };
}

/** The Card Data envelope: data + numbered pagination + the applied language. */
function catalogPage(data: unknown[], page: number, pageSize: number, total: number) {
  return ok(data, { page, page_size: pageSize, total_count: total, language: "en" });
}

describe("cards.search", () => {
  it("hits the default game's path and returns a NumberedPage", async () => {
    const fx = mockFetch([catalogPage([card("sv3pt5-223"), card("sv3pt5-6")], 1, 100, 2)]);
    const c = makeClient(fx);

    const page = await c.cards.search();

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/cards");
    expect(fx.last.method).toBe("GET");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.id).toBe("sv3pt5-223");
    expect(page.totalCount).toBe(2);
    expect(page.page).toBe(1);
    expect(page.language).toBe("en");
    expect(page.hasMore).toBe(false);
  });

  it("uses the client-wide game default", async () => {
    const fx = mockFetch([catalogPage([], 1, 100, 0)]);
    const c = makeClient(fx, { game: "onepiece" });
    await c.cards.search();
    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/cards");
  });

  it("overrides the game per call", async () => {
    const fx = mockFetch([catalogPage([], 1, 100, 0)]);
    const c = makeClient(fx);
    await c.cards.search({ game: "azuki" });
    expect(fx.last.url.pathname).toBe("/api/v1/azuki/cards");
  });

  it("encodes q, language, orderBy, distinct, include, select and paging", async () => {
    const fx = mockFetch([catalogPage([], 2, 25, 900)]);
    const c = makeClient(fx);

    await c.cards.search({
      q: "name:char* -types:water hp:[150 TO *]",
      language: "all",
      orderBy: "-release_date",
      distinct: "code",
      include: "prices",
      select: ["name", "rarity", "pricing"],
      page: 2,
      page_size: 25,
    });

    const q = fx.last.url.searchParams;
    expect(q.get("q")).toBe("name:char* -types:water hp:[150 TO *]");
    expect(q.get("language")).toBe("all");
    expect(q.get("orderBy")).toBe("-release_date");
    expect(q.get("distinct")).toBe("code");
    expect(q.get("include")).toBe("prices");
    expect(q.get("select")).toBe("name,rarity,pricing");
    expect(q.get("page")).toBe("2");
    expect(q.get("page_size")).toBe("25");
  });

  it("sends a comma list for a multi-code language filter", async () => {
    const fx = mockFetch([catalogPage([], 1, 100, 0)]);
    const c = makeClient(fx);
    await c.cards.search({ language: ["en", "ja"] });
    expect(fx.last.url.searchParams.get("language")).toBe("en,ja");
  });

  it("omits params the caller did not set", async () => {
    const fx = mockFetch([catalogPage([], 1, 100, 0)]);
    const c = makeClient(fx);
    await c.cards.search({ q: "pikachu" });
    expect(fx.last.url.search).toBe("?q=pikachu");
  });

  it("pages with next() and reports hasMore from total_count", async () => {
    const fx = mockFetch([
      catalogPage([card("a"), card("b")], 1, 2, 3),
      catalogPage([card("c")], 2, 2, 3),
    ]);
    const c = makeClient(fx);

    const first = await c.cards.search({ q: "charizard", page_size: 2 });
    expect(first.hasMore).toBe(true);

    const second = await first.next();
    expect(second).not.toBeNull();
    expect(fx.calls).toHaveLength(2);
    expect(fx.last.url.searchParams.get("page")).toBe("2");
    // The filter carries across to the next page.
    expect(fx.last.url.searchParams.get("q")).toBe("charizard");
    expect(second!.items.map((x) => x.id)).toEqual(["c"]);
    expect(second!.hasMore).toBe(false);
    expect(await second!.next()).toBeNull();
  });

  it("all() drains every page", async () => {
    const fx = mockFetch([
      catalogPage([card("a"), card("b")], 1, 2, 4),
      catalogPage([card("c"), card("d")], 2, 2, 4),
    ]);
    const c = makeClient(fx);
    const all = await (await c.cards.search({ page_size: 2 })).all();
    expect(all.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("maps 400 invalid_query to ValidationError with the details", async () => {
    const fx = mockFetch([
      fail(400, "invalid_query", "Unknown field 'colours'", { details: { position: 12 } }),
    ]);
    const c = makeClient(fx);

    const err = (await c.cards
      .search({ q: "name:char colours:red" })
      .catch((e: unknown) => e)) as ValidationError;

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_query");
    expect(err.message).toContain("Unknown field");
    expect(err.details).toEqual({ position: 12 });
  });
});

describe("cards.get", () => {
  it("fetches one card and unwraps data", async () => {
    const fx = mockFetch([ok(card("swshp_ja-104vh"))]);
    const c = makeClient(fx);

    const result = await c.cards.get("swshp_ja-104vh", { include: "prices" });

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/cards/swshp_ja-104vh");
    expect(fx.last.url.searchParams.get("include")).toBe("prices");
    expect(result.id).toBe("swshp_ja-104vh");
    expect(result.expansion.id).toBe("sv3pt5");
  });

  it("url-encodes the id and honours a per-call game", async () => {
    const fx = mockFetch([ok(card("op01-001"))]);
    const c = makeClient(fx);
    await c.cards.get("OP01-001/x", { game: "onepiece" });
    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/cards/OP01-001%2Fx");
  });

  it("accepts a null pricing object on include=prices", async () => {
    // Not every card has a market value — a whole game can sit in that state.
    const fx = mockFetch([ok(card("AZK01-006", { pricing: null }))]);
    const c = makeClient(fx);
    const result = await c.cards.get("AZK01-006", { game: "azuki", include: "prices" });
    expect(result.pricing ?? null).toBeNull();
    expect(result.pricing?.market).toBeUndefined();
  });

  it("maps 404 to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "not_found", "Card not found")]);
    const c = makeClient(fx);
    const err = (await c.cards.get("nope").catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
  });
});

describe("cards.printings", () => {
  it("returns the capped family page and does not try to page past it", async () => {
    const fx = mockFetch([
      // 50-row cap hit: total_count is the true family size.
      ok([card("eb01-001"), card("eb01-001vaa")], {
        page: 1,
        page_size: 50,
        total_count: 60,
        language: "all",
      }),
    ]);
    const c = makeClient(fx);

    const page = await c.cards.printings("eb01-001", { game: "onepiece", language: "ja" });

    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/cards/eb01-001/printings");
    expect(fx.last.url.searchParams.get("language")).toBe("ja");
    expect(page.items.map((x) => x.id)).toEqual(["eb01-001", "eb01-001vaa"]);
    expect(page.totalCount).toBe(60);
    expect(page.language).toBe("all");
    // Terminal: iterating never re-requests the same rows.
    expect(await page.all()).toHaveLength(2);
    expect(fx.calls).toHaveLength(1);
  });
});

describe("cards.prices", () => {
  it("returns { card_id, pricing } with numeric amounts", async () => {
    const fx = mockFetch([
      ok({
        card_id: "sv3pt5-223",
        pricing: {
          currency: "USD",
          market: 412.5,
          market_updated_at: "2026-09-01T04:15:00.000Z",
          is_stale: false,
          trend_7d: { direction: "up", percent: 4.2 },
          trend_30d: { direction: "up", percent: 11.8 },
          trend_90d: { direction: "down", percent: -3.4 },
          conditions: [
            { condition: "NM", price: 412.5, low: 380, high: 460, sold_count: 12 },
            { condition: "LP", price: 350.1 },
          ],
          graded: [
            {
              company: "PSA",
              grade: "10",
              value: 1200,
              low: 1050,
              high: 1400,
              confidence: "high",
              value_kind: "sold",
              sold_count: 37,
              last_sold_at: "2026-08-28T18:02:00.000Z",
              band: { median: 1180, recent_median: 1210, p10: 990, p90: 1450, count: 37 },
            },
          ],
        },
      }),
    ]);
    const c = makeClient(fx);

    const prices = await c.cards.prices("sv3pt5-223");

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/cards/sv3pt5-223/prices");
    expect(prices.card_id).toBe("sv3pt5-223");
    expect(prices.pricing.market).toBe(412.5);
    // The band and comp count on a rung are present when available, and the
    // rung beside it shows they can be absent.
    expect(prices.pricing.conditions?.[0]).toEqual({
      condition: "NM",
      price: 412.5,
      low: 380,
      high: 460,
      sold_count: 12,
    });
    expect(prices.pricing.conditions?.[1]).toEqual({ condition: "LP", price: 350.1 });
    expect(prices.pricing.trend_30d?.percent).toBe(11.8);
    expect(prices.pricing.trend_90d?.direction).toBe("down");
    expect(prices.pricing.graded[0]!.band?.count).toBe(37);
    expect(prices.pricing.graded[0]!.last_sold_at).toBe("2026-08-28T18:02:00.000Z");
  });

  it("accepts a null market", async () => {
    const fx = mockFetch([
      ok({
        card_id: "op01-001",
        pricing: { currency: "USD", market: null, is_stale: true, conditions: [], graded: [] },
      }),
    ]);
    const c = makeClient(fx);
    const prices = await c.cards.prices("op01-001", { game: "onepiece" });
    expect(prices.pricing.market).toBeNull();
  });

  it("copes with a card whose pricing object is omitted entirely", async () => {
    const fx = mockFetch([
      ok({
        card_id: "AZK01-006",
        // No per-condition data at all: `conditions` is absent rather than [].
        pricing: { currency: "USD", market: null, is_stale: true, graded: [] },
      }),
    ]);
    const c = makeClient(fx);
    const prices = await c.cards.prices("AZK01-006", { game: "azuki" });
    expect(prices.pricing.conditions ?? []).toEqual([]);
    expect(prices.pricing.trend_7d).toBeUndefined();
  });
});
