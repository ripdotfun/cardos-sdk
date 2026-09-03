import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError, type Expansion } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

function expansion(id: string, extra: Partial<Expansion> = {}): Expansion {
  return {
    id,
    name: "151",
    series: "Scarlet & Violet",
    code: "MEW",
    total: 207,
    printed_total: 165,
    language: "English",
    language_code: "en",
    release_date: "2023/09/22",
    logo: "https://cdn.rip.fun/sv3pt5-logo.png",
    symbol: "https://cdn.rip.fun/sv3pt5-symbol.png",
    ...extra,
  };
}

function catalogPage(data: unknown[], page: number, pageSize: number, total: number) {
  return ok(data, { page, page_size: pageSize, total_count: total, language: "en" });
}

describe("expansions.search", () => {
  it("lists expansions on the default game", async () => {
    const fx = mockFetch([catalogPage([expansion("sv3pt5"), expansion("sv1")], 1, 100, 2)]);
    const c = makeClient(fx);

    const page = await c.expansions.search();

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/expansions");
    expect(page.items.map((e) => e.id)).toEqual(["sv3pt5", "sv1"]);
    expect(page.totalCount).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it("encodes q, orderBy, language, select and paging, and overrides the game", async () => {
    const fx = mockFetch([catalogPage([], 1, 50, 120)]);
    const c = makeClient(fx);

    await c.expansions.search({
      game: "onepiece",
      q: "release_date:[2024-01-01 TO *]",
      orderBy: "-release_date",
      language: "ja",
      select: ["name", "release_date"],
      page: 1,
      page_size: 50,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/expansions");
    const q = fx.last.url.searchParams;
    expect(q.get("q")).toBe("release_date:[2024-01-01 TO *]");
    expect(q.get("orderBy")).toBe("-release_date");
    expect(q.get("language")).toBe("ja");
    expect(q.get("select")).toBe("name,release_date");
    expect(q.get("page_size")).toBe("50");
  });

  it("fetches page 2 through next()", async () => {
    const fx = mockFetch([
      catalogPage([expansion("a"), expansion("b")], 1, 2, 3),
      catalogPage([expansion("c")], 2, 2, 3),
    ]);
    const c = makeClient(fx);

    const first = await c.expansions.search({ page_size: 2 });
    const second = await first.next();

    expect(fx.last.url.searchParams.get("page")).toBe("2");
    expect(second!.items.map((e) => e.id)).toEqual(["c"]);
    expect(second!.hasMore).toBe(false);
  });

  it("maps 400 invalid_pagination to ValidationError", async () => {
    const fx = mockFetch([
      fail(400, "invalid_pagination", "page * page_size must not exceed 10000"),
    ]);
    const c = makeClient(fx);
    const err = (await c.expansions
      .search({ page: 500, page_size: 100 })
      .catch((e: unknown) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("invalid_pagination");
  });
});

describe("expansions.get", () => {
  it("returns the expansion object", async () => {
    const fx = mockFetch([ok(expansion("sv3pt5"))]);
    const c = makeClient(fx);

    const set = await c.expansions.get("sv3pt5", { select: ["name", "total"] });

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/expansions/sv3pt5");
    expect(fx.last.url.searchParams.get("select")).toBe("name,total");
    expect(set.printed_total).toBe(165);
  });

  it("maps 404 to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "not_found", "Expansion not found")]);
    const c = makeClient(fx);
    const err = (await c.expansions.get("sv1", { game: "onepiece" }).catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/expansions/sv1");
  });
});

describe("expansions.cards", () => {
  it("pages an expansion's cards with the card search params", async () => {
    const fx = mockFetch([
      ok([{ id: "eb01-001" }], { page: 1, page_size: 30, total_count: 60, language: "all" }),
    ]);
    const c = makeClient(fx);

    const page = await c.expansions.cards("eb01", {
      game: "onepiece",
      q: "colors:Red",
      distinct: "code",
      include: "prices",
      page_size: 30,
    });

    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/expansions/eb01/cards");
    const q = fx.last.url.searchParams;
    expect(q.get("q")).toBe("colors:Red");
    expect(q.get("distinct")).toBe("code");
    expect(q.get("include")).toBe("prices");
    expect(q.get("page_size")).toBe("30");
    expect(page.items[0]!.id).toBe("eb01-001");
    expect(page.language).toBe("all");
  });
});
