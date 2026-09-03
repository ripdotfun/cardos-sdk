/**
 * Card Data: search the catalog, read one card's prices, walk an expansion.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/browse-catalog.ts
 *
 * Every call here costs 1 credit, flat — a page of 100 cards with prices
 * embedded costs the same as one card without them, and strictly less than a
 * second call per row. Only 2xx/304 are billed; anything 4xx/5xx is refunded,
 * and 429s never reach metering at all.
 *
 * https://business.getcardos.com/docs/search
 * https://business.getcardos.com/docs/credits
 */

import { CardOS, ValidationError } from "../src/index.js";

const cardos = new CardOS({
  apiKey: process.env.CARDOS_API_KEY!,
  game: "pokemon", // default for cards / expansions / sealed; override per call
});

async function main(): Promise<void> {
  // --- search -------------------------------------------------------------
  // `q` is a small Lucene-ish grammar: bare words match `name`, terms AND by
  // default, `OR` + parens group, `-` excludes, `!field:` is an exact match,
  // `*` wildcards, `[a TO b]` inclusive ranges, `{a TO b}` exclusive.
  const chase = await cardos.cards.search({
    q: 'rarity:"Special Illustration Rare" raw_price:[100 TO *] -types:water',
    orderBy: "-raw_price",
    include: "prices", // no surcharge
    page_size: 20,
  });
  console.log(`${chase.totalCount} matches, page ${chase.page} of ${chase.pageSize}:`);
  for (const card of chase.items) {
    console.log(`  ${card.id}  ${card.name}  $${card.pricing?.market ?? "—"}`);
  }

  // A few more query shapes worth stealing:
  //   name:charizard subtypes:vmax                  both terms
  //   (subtypes:mega OR subtypes:vmax)              either
  //   name:char* -types:water                       wildcard, minus exclusion
  //   hp:[150 TO *]                                 open-ended range
  //   expansion.release_date:[2024-01-01 TO *]      nested field
  //   code:OP01-016                                 One Piece card code
  await cardos.cards.search({ game: "onepiece", q: "colors:Black cost:[1 TO 3] type:Character" });

  // --- one card + its prices ---------------------------------------------
  const card = await cardos.cards.get("swsh7-215", { include: "prices" });
  console.log(`\n${card.name} · ${card.expansion?.name} #${card.number}`);
  console.log(`  image: ${card.images?.[0]?.large}`);

  const prices = await cardos.cards.prices(card.id);
  console.log(`  market: $${prices.pricing.market} (${prices.pricing.currency})`);
  for (const rung of prices.pricing.conditions ?? []) {
    console.log(`    ${rung.condition}: $${rung.price}`);
  }
  for (const slab of prices.pricing.graded ?? []) {
    console.log(`    ${slab.company} ${slab.grade}: $${slab.value}`);
  }

  // --- expansions ---------------------------------------------------------
  const sets = await cardos.expansions.search({
    q: "release_date:[2024-01-01 TO *]",
    orderBy: "-release_date",
    page_size: 5,
  });
  for (const set of sets.items) {
    console.log(`\n${set.id}  ${set.name}  (${set.total} cards, ${set.release_date})`);
  }

  // --- paging -------------------------------------------------------------
  // A NumberedPage is an AsyncIterable over ITEMS; `for await` fetches the
  // next page lazily. `page × page_size` is capped at 10 000 server-side, so
  // narrow with `q` rather than paging deeper.
  let counted = 0;
  for await (const c of await cardos.cards.search({ q: "expansion.id:sv3pt5", page_size: 100 })) {
    counted++;
    if (counted >= 250) break; // stop early — the iterator stops fetching
    void c;
  }
  console.log(`\nwalked ${counted} cards`);

  // Or drain it in one go when you know the result set is small:
  const box = await cardos.sealed.search({ q: "product_type:booster_box expansion.id:sv3pt5" });
  console.log((await box.all()).map((p) => p.name).join("\n"));

  // --- a bad query is a 400 with the offending position -------------------
  try {
    await cardos.cards.search({ q: "nosuchfield:1" });
  } catch (err) {
    if (err instanceof ValidationError) {
      // unknown_field / parse_error / invalid_value carry details.position.
      console.log(`\n${err.code}: ${err.message}`, err.details);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
