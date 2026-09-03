import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError, type SealedProduct } from "../src/index.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

function product(id: string, extra: Partial<SealedProduct> = {}): SealedProduct {
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
    name: "Scarlet & Violet 151 Elite Trainer Box",
    product_type: "elite_trainer_box",
    expansion: {
      id: "sv3pt5",
      name: "151",
      total: 207,
      language: "English",
      language_code: "en",
      release_date: "2023/09/22",
    },
    language: "English",
    language_code: "en",
    release_date: "2023/09/22",
    pack_count: 9,
    cards_per_pack: 10,
    tcgplayer_id: "500123",
    images,
    ...extra,
  };
}

function catalogPage(data: unknown[], page: number, pageSize: number, total: number) {
  return ok(data, { page, page_size: pageSize, total_count: total, language: "en" });
}

describe("sealed.search", () => {
  it("hits the sealed path and returns a NumberedPage", async () => {
    const fx = mockFetch([catalogPage([product("sv3pt5-etb")], 1, 100, 1)]);
    const c = makeClient(fx);

    const page = await c.sealed.search();

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/sealed");
    expect(page.items[0]!.product_type).toBe("elite_trainer_box");
    expect(page.totalCount).toBe(1);
  });

  it("encodes product_type (single and list), q, include and paging", async () => {
    const fx = mockFetch([catalogPage([], 1, 100, 0), catalogPage([], 1, 100, 0)]);
    const c = makeClient(fx);

    await c.sealed.search({
      q: "expansion.id:sv3pt5",
      product_type: "booster_box",
      include: "prices",
    });
    let q = fx.last.url.searchParams;
    expect(q.get("q")).toBe("expansion.id:sv3pt5");
    expect(q.get("product_type")).toBe("booster_box");
    expect(q.get("include")).toBe("prices");

    await c.sealed.search({ game: "onepiece", product_type: ["booster_box", "tin"] });
    q = fx.last.url.searchParams;
    expect(fx.last.url.pathname).toBe("/api/v1/onepiece/sealed");
    expect(q.get("product_type")).toBe("booster_box,tin");
  });

  it("pages with next()", async () => {
    const fx = mockFetch([
      catalogPage([product("a"), product("b")], 1, 2, 3),
      catalogPage([product("c")], 2, 2, 3),
    ]);
    const c = makeClient(fx);

    const first = await c.sealed.search({ page_size: 2, orderBy: "-price" });
    expect(first.hasMore).toBe(true);

    const second = await first.next();
    expect(fx.last.url.searchParams.get("page")).toBe("2");
    expect(fx.last.url.searchParams.get("orderBy")).toBe("-price");
    expect(second!.items.map((p) => p.id)).toEqual(["c"]);
    expect(second!.hasMore).toBe(false);
  });

  it("maps 400 invalid_value to ValidationError", async () => {
    const fx = mockFetch([
      fail(400, "invalid_value", 'product_type value "starter_deck" is not supported'),
    ]);
    const c = makeClient(fx);
    const err = (await c.sealed
      .search({ product_type: "starter_deck" })
      .catch((e: unknown) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("invalid_value");
  });
});

describe("sealed.get", () => {
  it("returns one product with inline pricing", async () => {
    const fx = mockFetch([
      ok(
        product("sv3pt5-etb", {
          pricing: {
            currency: "USD",
            market: 89.99,
            updated_at: "2026-09-01T04:15:00.000Z",
            is_on_sale: true,
            sale_price: 79.5,
            trend_7d: { direction: "down", percent: -2.1 },
          },
        }),
      ),
    ]);
    const c = makeClient(fx);

    const item = await c.sealed.get("sv3pt5-etb", { include: "prices" });

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/sealed/sv3pt5-etb");
    expect(fx.last.url.searchParams.get("include")).toBe("prices");
    expect(item.pricing?.market).toBe(89.99);
    expect(item.pricing?.sale_price).toBe(79.5);
    expect(item.pack_count).toBe(9);
  });

  it("maps 404 to NotFoundError", async () => {
    const fx = mockFetch([fail(404, "not_found", "Sealed product not found")]);
    const c = makeClient(fx);
    const err = (await c.sealed.get("nope").catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
  });
});

describe("sealed.prices", () => {
  it("returns { product_id, pricing } with the one-rung ladder and history", async () => {
    const fx = mockFetch([
      ok({
        product_id: "sv3pt5-etb",
        pricing: {
          currency: "USD",
          market: 89.99,
          updated_at: "2026-09-01T04:15:00.000Z",
          is_on_sale: false,
          trend_7d: { direction: "flat", percent: 0 },
          conditions: [{ condition: "sealed", price: 89.99 }],
          history: [
            { date: "2026-08-25T00:00:00.000Z", price: 92.0, source: "tcgplayer" },
            { date: "2026-09-01T00:00:00.000Z", price: 89.99, source: "tcgplayer" },
          ],
        },
      }),
    ]);
    const c = makeClient(fx);

    const prices = await c.sealed.prices("sv3pt5-etb");

    expect(fx.last.url.pathname).toBe("/api/v1/pokemon/sealed/sv3pt5-etb/prices");
    expect(prices.product_id).toBe("sv3pt5-etb");
    expect(prices.pricing.conditions).toEqual([{ condition: "sealed", price: 89.99 }]);
    expect(prices.pricing.history).toHaveLength(2);
  });

  it("reports a null market for an MSRP-priced product", async () => {
    const fx = mockFetch([
      ok({
        product_id: "azuki-box",
        pricing: {
          currency: "USD",
          market: null,
          is_on_sale: false,
          conditions: [],
          history: [],
        },
      }),
    ]);
    const c = makeClient(fx);
    const prices = await c.sealed.prices("azuki-box", { game: "azuki" });
    expect(fx.last.url.pathname).toBe("/api/v1/azuki/sealed/azuki-box/prices");
    expect(prices.pricing.market).toBeNull();
  });
});
