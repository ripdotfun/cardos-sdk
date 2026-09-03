# `@cardos/sdk`

Official TypeScript SDK for the [CardOS](https://business.getcardos.com) APIs — mystery packs,
instant packs, custodial wallets, sell-back, physical redemption, revenue share, webhooks,
and the Card Data catalog for Pokémon, One Piece and Azuki.

Zero runtime dependencies. Isomorphic: Node ≥ 20, Bun, Deno, Cloudflare Workers, Vercel Edge
and the browser. ESM + CJS. Every response is fully typed from the API's own field names.

Full API reference: [business.getcardos.com/docs](https://business.getcardos.com/docs) (Card Data),
[/gacha-docs](https://business.getcardos.com/gacha-docs) (Gacha),
[/instant-docs](https://business.getcardos.com/instant-docs) (Instant Pack).

```sh
pnpm add @cardos/sdk
```

```ts
import { CardOS } from "@cardos/sdk";
const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });

// Sell a pack, filled from real cards in the vault.
const purchase = await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });
const { items } = await cardos.gacha.waitForReveal(purchase.id);
// → [{ name: 'Umbreon VMAX', value_usd: '412.50', image_url: '…', card_id: 'swsh7-215', … }]
```

Three lines, one real card. Everything below is detail.

---

## Contents

- [Configuration](#configuration)
- [Gacha — mystery packs](#gacha--mystery-packs)
- [Instant packs](#instant-packs)
- [Wallet](#wallet)
- [Self-custody flow](#self-custody-flow)
- [Sell-back](#sell-back)
- [Redemption](#redemption)
- [Revenue](#revenue)
- [Card Data](#card-data)
- [Webhooks](#webhooks)
- [Pagination](#pagination)
- [Errors](#errors)
- [Idempotency](#idempotency)
- [Polling](#polling)
- [Environments & rate limits](#environments--rate-limits)
- [TypeScript notes](#typescript-notes)

---

## Configuration

Keys are self-serve from the dashboard and are sent as `X-API-Key` —
[Authentication](https://business.getcardos.com/docs/authentication).

```ts
const cardos = new CardOS({
  apiKey: process.env.CARDOS_API_KEY!,   // required — sent as X-API-Key
  environment: "production",             // "production" (default) | "staging"
  // baseUrl: "https://api.internal/cardos", // your proxy; overrides `environment`
  game: "pokemon",                       // default game for cards/expansions/sealed
  timeoutMs: 30_000,                     // per-request, default 30 000
  maxRetries: 2,                         // 429 / 5xx / network, default 2
  fetch: myInstrumentedFetch,            // defaults to globalThis.fetch
  defaultHeaders: { "x-app": "storefront" },  // merged into every request
});
```

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | Your partner key, `rip_v1_…`. Required. |
| `environment` | `"production"` | `"production"` → `https://api.getcardos.com` (Base mainnet), `"staging"` → `https://staging-service.rip.fun` (Base Sepolia). |
| `baseUrl` | — | Point at your own proxy or a mock server. Wins over `environment`. |
| `game` | `"pokemon"` | Default for Card Data calls; override per call with `params.game`. |
| `timeoutMs` | `30000` | Per request. Override per call with `{ timeoutMs }`. |
| `maxRetries` | `2` | GETs, DELETEs and POSTs carrying an idempotency key. |
| `fetch` | `globalThis.fetch` | A polyfill, a tracing wrapper, or a test double. |

Every method also takes per-call overrides — `signal`, `timeoutMs`, `headers`, `maxRetries` —
alongside its own params:

```ts
await cardos.gacha.catalog({ active: true, signal: ac.signal, timeoutMs: 5_000 });
```

## Gacha — mystery packs

Docs: [Gacha API](https://business.getcardos.com/gacha-docs) ·
[End-to-end flows](https://business.getcardos.com/gacha-docs/flows)

A tier is a price point; buying one draws real cards out of the vault, and the reveal is random.

```ts
// 1. What can you sell? Price, EV and slot count are read live from the pool.
const tiers = await cardos.gacha.catalog({ game: "pokemon", active: true });
// [{ tier_id: 3, name: 'Chase', price_usdc: '25.000000', price_display: '$25.00',
//    target_ev_usdc: '22.500000', slot_count: 1, active: true, … }]

// Per-tier odds, if you show them.
const odds = await cardos.gacha.odds(3);

// 2. Buy — 202, the pack is RESERVED and the purchase is in flight on-chain.
const purchase = await cardos.gacha.purchase({
  tier_id: 3,
  external_user_id: user.id,      // or wallet_address
  max_price_usdc: "25.000000",    // optional price cap
});
// { id: 5012, status: 'RESERVED', custody: 'CUSTODIAL', memo: 'acme-5012', … }

// 3. Wait for the reveal. Polls with backoff; usually a few seconds.
const revealed = await cardos.gacha.waitForReveal(purchase.id);
for (const item of revealed.items ?? []) {
  console.log(item.name, item.value_usd, item.image_url, item.card_id);
}

// 4. What the user owns.
const collection = await cardos.gacha.collection({ external_user_id: user.id });
collection.user;   // { external_user_id, wallet_address }
collection.items;  // CollectionItem[] — still_owned: false once sold back / redeemed
```

Price, EV, slot count and `active` are read live from the pool. A `null` price means
*temporarily* unavailable — never a real price, and never free — so re-fetch shortly rather than
treating the tier as unsellable. `gacha.games()` lists every game on offer and is computed before
filtering, so it stays complete as the filter UI you build from it.

`waitForReveal` resolves on `FULFILLED` / `PARTIALLY_FULFILLED` and throws
[`TerminalStateError`](#errors) on `REFUNDED` (e.g. the machine was empty — the hold is already
back) or `FAILED` (a pre-broadcast error). Poll for the "opening…" animation; in production drive
fulfilment off the [`purchase.fulfilled` webhook](#webhooks).

Also on `cardos.gacha`: `getPurchase(id)`, `listPurchases({ status, external_user_id, … })`,
`stats()`, `feed.recent()` / `feed.winners()` / `feed.mine()`, and
`price({ card_id })` / `price({ token_id })` for a single item's market and buyback value.
Feed rows are unique on `(token_id, revealed_at)`, not `token_id` alone — a card sold back and
pulled again appears once per reveal, so key any UI list on the pair.

## Instant packs

Docs: [Instant Pack API](https://business.getcardos.com/instant-docs)

A real booster pack, bought and opened in one on-chain transaction. Each pack in the catalog is
backed by a pre-built bundle from a physically ripped pack, so `available_packs` is live inventory.

```ts
const packs = await cardos.instant.catalog({ include_unavailable: false });
packs.items;
// [{ packet_type_id: 41, set_id: 'sv3pt5', name: '151 Booster Pack',
//    price_usdc: '5.500000', available_packs: 812, image_url: '…', tcg_type: 'pokemon' }]

// Same prepare → the user sends → submit shape as gacha.
const prep = await cardos.instant.prepare({
  wallet_address: user.wallet,
  packet_type_id: 41,
});
const transaction_hash = await wallet.sendCalls(prep.calls);
const purchase = await cardos.instant.submit({
  wallet_address: user.wallet,
  packet_type_id: 41,
  transaction_hash,
});

const delivered = await cardos.instant.waitForDelivery(purchase.id);
delivered.pack;   // { unique_id, set_id, name, image_url, opened_at }
delivered.cards;  // [{ card_id, name, rarity, is_chase, value_usd, large_image_url, … }]
```

The end user holds their own funds and their own cards; CardOS never touches them, and the cards
deliver straight to that wallet. Unlike the redemption and sell-back calls, instant calls carry no
`kind` discriminator — dispatch on position: `calls[0]` is the USDC approve, `calls[1]` the
buy-and-open. Delivery is asynchronous: usually a few seconds, up to ~90 s
while the VRF settles, so `waitForDelivery` defaults to a 180 s timeout. `available_packs: 0`
means a purchase will fail with `409 sold_out`. Instant cards come from a different pool than
combo tiers, so they carry no buyback window — they can still be [redeemed](#redemption)
physically.

## Wallet

Docs: [Custodial wallet](https://business.getcardos.com/gacha-docs/custodial-wallet/wallet-balance)

If your users don't have wallets, fund a per-user CardOS credits wallet in USDC on Base and open
packs server-side: `gacha.purchase` pays from the balance, with no transaction for anyone to sign
and no chain awareness in your stack. The pulled cards are minted to a CardOS-managed wallet keyed
to your `external_user_id`.

```ts
const { address, chain, currency } = await cardos.wallet.depositAddress({
  external_user_id: user.id,
});
// → { chain: 'base', address: '0x…', currency: 'USDC', dedicated: false }

const { wallet } = await cardos.wallet.balance({ external_user_id: user.id });
// { available_usdc: '17.500000', reserved_usdc: '0.000000', balance_usdc: '17.500000' }

const ledger = await cardos.wallet.ledger({ external_user_id: user.id, limit: 50 });
const deposits = await cardos.wallet.deposits({ external_user_id: user.id });
```

`available` is what a new purchase can reserve; `reserved` is held by in-flight purchases and
released on refund. Money is always a string, never a JSON number: `available_usdc` is a decimal
string for display, `available` the same value as integer USDC micros. Never `Number()` either.
`ledger` is the full audit trail — deposits credited, purchase reserves, settlements and refunds,
each with the running balance after it, and `source` / `source_id` tying an entry back to what
caused it.

## Self-custody flow

Docs: [End-to-end flows](https://business.getcardos.com/gacha-docs/flows)

The default model: the end user holds their own funds and their own cards. CardOS hands you the
transactions to send, your wallet layer gets the user to send them, and you record the hash. The
SDK never touches a private key.

```ts
// 1. Ask for the calls.
const prep = await cardos.gacha.prepare({ wallet_address: user.wallet, tier_id: 3 });
// { chain_id: 8453, contract: '0x…', max_price_usdc: '25.000000',
//   calls: [{ to, data, kind: 'erc20-approve', description }, { to, data, kind: 'purchase', … }] }

// 2. The end user SENDS these as transactions (signing a message does nothing
//    on-chain). Dispatch on `kind` — not on the description, not on the 4-byte
//    selector. Under account abstraction an `erc20-approve` must be its own
//    userop, and you can skip it when the allowance already covers the price.
const transaction_hash = await wallet.sendCalls(prep.calls);

// 3. Tell us, once it is mined. 202.
const purchase = await cardos.gacha.submit({
  wallet_address: user.wallet,
  tier_id: 3,
  transaction_hash,
});
const revealed = await cardos.gacha.waitForReveal(purchase.id);
```

`submit` records the hash so CardOS can link the reveal to it; pass `request_id` from the receipt
logs when you have it and linking is faster. The `202` body is the same serialized purchase
`getPurchase` returns — including `items` when the reveal already settled — so check `status`
before scheduling the first poll. `cardos.instant` has the same `prepare` / `submit` pair.

## Sell-back

Docs: [Buyback](https://business.getcardos.com/gacha-docs/buyback/sellback-quote) ·
[Flows](https://business.getcardos.com/gacha-docs/flows)

Instant cash for a pull: the holder sells the card straight back into the combo pool, out of the
buyback float the pack price already deposited. The card is restocked into the pool it came from,
and the payout shows up as a deduction in your [net revenue](#revenue). This is the TIER model,
which is what partner accounts settle on.

```ts
const quote = await cardos.sellback.quote({
  wallet_address: user.wallet,
  token_ids: ["10231", "10232"],     // max 50 per batch
});
// { items: [{ token_id, eligible, reason, payout_usdc, expires_at }],
//   eligible_token_ids, total_payout_usdc, approval_needed,
//   pool_liquidity_usdc, sufficient_liquidity }

const prep = await cardos.sellback.prepare({
  wallet_address: user.wallet,
  token_ids: quote.eligible_token_ids,
  slippage_bps: 100,                 // 1%, the default
});
const transaction_hash = await wallet.sendCalls(prep.calls); // set-approval-for-all, then sellback

await cardos.sellback.submit({ transaction_hash, wallet_address: user.wallet });
const history = await cardos.sellback.list({ limit: 50 });
```

The contract enforces two rules that `quote` pre-flights for you: only the card's **original
recipient** may sell it back (a card that changed hands never can), and only **before its buyback
window expires**. A batch is capped at 50 tokens and is all-or-nothing on-chain, so check every
item is `eligible` before going further — `reason` on an ineligible one is `no_window` (never
pool-distributed, or already sold), `wrong_holder`, `window_expired` or `value_unknown`.
The `setApprovalForAll` call is included only when it is
actually missing. `slippage_bps` is on-chain protection — the pool re-reads the price oracle at
execution time, and the default allows 1% of downward drift. Re-submitting the same hash is safe:
the payout is decoded from the on-chain event, never from your request.

`cardos.buyback` is the separate, legacy **POOL**-model offer flow, kept for a few grandfathered
partners who hold their own inventory. It is not offered to new partners and answers `403
not_pool_partner` on a TIER account — `GET /api/v1/info` reports which model your key is on.

## Redemption

Docs: [Physical redemption](https://business.getcardos.com/gacha-docs/redemption/redemption-quote) ·
[Flows](https://business.getcardos.com/gacha-docs/flows)

Ship the physical card. Only the card's holder can start it, and they pay the quoted shipping in
USDC on-chain themselves — you are never billed for shipping.

> **CardOS runs no KYC/AML, so screening your end user is your responsibility.** Run whatever
> identity checks your jurisdiction and risk policy require, on the current holder, *before* you
> call `prepare`, and keep the records. `prepare` returns the transactions right away for any
> eligible card the holder owns.

```ts
// 1. Quote — creates nothing, so it is safe behind an address form.
const quote = await cardos.redemption.quote({
  token_id: "10231",
  shipping_address: { name, street1, city, state, zip, country },  // + street2/phone/email
});
// { amount_usdc: '6.85', currency: 'USD', carrier: 'USPS', service: 'Priority',
//   service_token: 'usps_priority', estimated_days: 3, rate_id, quoted_at }

// 2. Prepare — locks that quote (single-use, payer-bound, amount-locked) and
//    returns the unsigned calls.
const prepared = await cardos.redemption.prepare({ token_id: "10231", shipping_address });
// { redemption_id: 31, status: 'PREPARED', expires_at,
//   shipping_payment: { total_usdc, processor, expiration_time, provider_order_id },
//   unsigned: { chain_id, calls: [burn, erc20-approve, shipping-payment] } }

// 3. The HOLDER sends these as transactions, in order — the shipping payment
//    only succeeds after the redemption-flag call. Under account abstraction
//    the `erc20-approve` must be its own userop. Nothing leaves the wallet
//    here: the card is only flagged, and expect no token transfer in the UI.
const tx_hash = await wallet.sendCalls(prepared.unsigned!.calls);

// 4. Record the hash. 202 — fulfilment takes over. Re-submitting is safe.
await cardos.redemption.submit({ redemption_id: prepared.redemption_id, tx_hash });

// 5. Track. `get` takes a purchase id or a token id and returns every
//    redemption against it.
const [current] = await cardos.redemption.get("10231", { verify: true });
current.status;                    // BURN_SUBMITTED | IN_FULFILLMENT | COMPLETED | …
current.order?.tracking_number;
```

Statuses: `PREPARED` → `BURN_SUBMITTED` → `IN_FULFILLMENT` → `COMPLETED`, or `FAILED` /
`CANCELLED` / `EXPIRED`. A prepare (and the signed shipping quote inside it) stays valid for 24 h
by default; an `EXPIRED` one is retryable with a **new** idempotency key.
`cardos.redemption.list({ status })` pages the lot. Subscribe to `redemption.updated` rather than
polling — it fires on every transition after `redemption.prepared`.

**The card is burned when the item ships, not when the holder sends the transaction.** That
transaction only flags the card; CardOS ships once the shipping payment lands on-chain and burns
the card on dispatch. A wallet showing a plain contract interaction with no token transfer is
correct, not a failure.

Identify the card by `purchase_id` **or** `token_id` — `token_id` alone works for cards you
distributed yourself, with no CardOS purchase behind them.

## Revenue

Docs: [Net revenue & your share](https://business.getcardos.com/gacha-docs/revenue-payouts/revenue-summary)

There is no per-item receivable: CardOS owns the inventory and funds the buyback float, and you
earn a share of net revenue.

```ts
const terms = await cardos.revenue.terms();
// { plan: 'STANDARD', revenue_share_bps: 500, revenue_share_pct: '5.00',
//   instant_revenue_share_bps: 100, payout_schedule: 'QUARTERLY',
//   payout_currency: 'USDC', payout_wallet: { chain: 'base', address: '0x…' } }

const summary = await cardos.revenue.summary({ from: "2026-07-01", to: "2026-10-01" });
// gross_usdc − sellback_usdc − fees_usdc = net_usdc; your share = net × rate
summary.by_product.tier;      // { packs, gross_usdc, sellback_usdc, net_usdc, share_bps, share_usdc }
summary.by_product.instant;   // same shape; instant packs have no sell-backs to deduct

const payouts = await cardos.revenue.payouts({ limit: 20 });
payouts.items;                // closed statements, newest first
await cardos.revenue.outstanding();   // { outstanding_usdc, accruing, total_owed_usdc }

await cardos.revenue.getPayoutWallet();
await cardos.revenue.setPayoutWallet({ address: "0x…", chain: "base" });
```

Gross is what your end users paid for *qualifying* packs — those whose reveal included a raw card.
It counts `SUBMITTED` / `FULFILLED` / `PARTIALLY_FULFILLED` and excludes `REFUNDED` / `FAILED`.
Rates are per product and negotiated: typically 5% of net on combo tiers and 1% of gross on
instant packs (instant cards carry no buyback window, so there is nothing to deduct) — read
`terms()`, don't hardcode. Paid in USDC quarterly by default; `payout_schedule` may also be
`MONTHLY` or `CUSTOM`. Closing a period **freezes** its figures and its rates, so a later
renegotiation changes future periods only and nothing already paid is restated. A period where
sell-backs outrun sales earns nothing rather than clawing back against the next one.

The payout-wallet endpoints need the exclusive `payout:manage` scope, which a partner `admin`
key does **not** satisfy.

## Card Data

Docs: [Card Data API](https://business.getcardos.com/docs) ·
[Search & filtering](https://business.getcardos.com/docs/search) ·
[Pricing data](https://business.getcardos.com/docs/pricing)

The catalog behind rip.fun: Pokémon, One Piece and Azuki cards, their printings, their images and
their market prices. Every card exists once per printed language, each with its own id, artwork
and pricing — not a translation field on the English one.

```ts
const cardos = new CardOS({ apiKey, game: "pokemon" });  // default game

// `q` is a small Lucene-ish grammar.
const page = await cardos.cards.search({
  q: 'rarity:"Special Illustration Rare" raw_price:[100 TO *] -types:water',
  orderBy: "-raw_price",
  include: "prices",       // embeds `pricing` on every row — no surcharge
  page_size: 100,
});
page.items;        // Card[]
page.totalCount;   // total matches

const card = await cardos.cards.get("swsh7-215", { include: "prices" });
const prices = await cardos.cards.prices("swsh7-215");
// { card_id, pricing: { currency, market, market_updated_at, is_stale, trend_7d,
//   conditions: [{ condition: 'NM', price, low, high, sold_count }],
//   graded: [{ company: 'PSA', grade: '10', value, low, high, confidence }] } }

const printings = await cardos.cards.printings("swsh7-215");   // the same card, every finish
const sets = await cardos.expansions.search({ q: "release_date:[2024-01-01 TO *]" });
const inSet = await cardos.expansions.cards("sv3pt5", { include: "prices" });
const boxes = await cardos.sealed.search({ q: "product_type:booster_box expansion.id:sv3pt5" });
```

**`q` grammar.** Bare words match `name`. Terms AND by default; uppercase `OR` and parens
group; a leading `-` excludes. `field:value` matches a substring case-insensitively;
`!field:value` is an exact whole-value match. `*` wildcards anywhere but the start.
`[a TO b]` is an inclusive range, `{a TO b}` exclusive, `*` an open end.

```
name:charizard subtypes:vmax
(subtypes:mega OR subtypes:vmax)
name:char* -types:water
rarity:"Special Illustration Rare"
hp:[150 TO *]
expansion.release_date:[2024-01-01 TO *]
colors:Black cost:[1 TO 3] type:Character     # One Piece
code:OP01-016
product_type:booster_box expansion.id:sv3pt5  # sealed
```

Caps: 512 characters, 20 terms, 5 levels of nesting, `orderBy` at most 3 keys — past those
it is a `400 query_too_complex`. A malformed `q` is a `400 invalid_query` with `details.position`,
the 0-based character offset, in `err.details`; unknown fields, leading wildcards and unquoted
spaces are rejected rather than ignored.

**Shared params.** `language` (defaults to `en` on search; comma list, or `"all"` — the
applied value comes back on the page), `orderBy` (`-` for DESC, missing values sort last),
`select` (trims the payload, not the credit cost), `distinct: "code"` (collapses a code's
printings to one row), `page` / `page_size` (1–100, default 100 — out of range is a `400`, never
a silent clamp), and `game` to override the client default per call.

**Games:** `pokemon` (en, ja, zh), `onepiece` (en, ja), `azuki` (en). Azuki has no marketplace
behind it, so it carries no market pricing — sealed product reports MSRP and nothing else.

Card Data lists return a [`NumberedPage`](#pagination):

```ts
for await (const card of await cardos.cards.search({ q: "expansion.id:sv3pt5" })) {
  console.log(card.id, card.name, card.pricing?.market);
}
```

**Credits** ([docs](https://business.getcardos.com/docs/credits))**.** 1 credit per catalog read,
flat — a page of 100 with `include=prices` costs the same as a single card without them, and
strictly less than a second call per row. Only `2xx`/`304` are billed; anything 4xx/5xx is
refunded. The Gacha and Instant Pack APIs don't spend credits at all.

Prices move on a recompute schedule — there is nothing to gain from polling faster than
`market_updated_at` changes. Metadata and images are safe to cache for days; see
[Best practices](https://business.getcardos.com/docs/best-practices).

## Webhooks

Docs: [Webhooks guide](https://business.getcardos.com/gacha-docs/webhooks-guide)

Register an endpoint (scope `webhooks:manage`), then verify every delivery. Verification lives in
a **separate entry point**, `@cardos/sdk/webhooks`, so a request handler can import it without the
HTTP client. It is implemented on Web Crypto, so it runs unchanged on Node, Bun, Deno, Workers and
Edge.

```ts
const hook = await cardos.webhooks.register({
  url: "https://you.example/hooks/cardos",
  event_types: ["purchase.fulfilled", "purchase.refunded", "purchase.failed"],
  // omit `event_types` to receive everything
});
hook.signing_secret;  // ← a 64-hex string, returned exactly ONCE, at creation.
                      //   Store it now; `list()` never returns secrets.

await cardos.webhooks.list();          // no secrets
await cardos.webhooks.get(hook.id);
await cardos.webhooks.delete(hook.id);
await cardos.webhooks.deliveries({ limit: 20 });  // the debug log: status, attempts, last_error
```

Up to **20 webhooks** per partner; private or internal URLs are rejected.

Each delivery is a `POST` carrying `X-Mystery-Event`, `X-Mystery-Delivery` (the event id —
dedupe on it), `X-Mystery-Timestamp` and `X-Mystery-Signature` (`t=<unix_ms>,sha256=<hex>`,
an HMAC-SHA256 over `"<t>.<raw_body>"`, compared constant-time). Reject anything older than
~5 minutes. Any non-2xx response or timeout is retried, up to **6 attempts** with exponential
backoff, so a slow consumer *will* see the same event twice.

**Express** — `express.raw`, never `express.json()`: parsing and re-serialising reorders the
JSON and breaks the HMAC.

```ts
import express from "express";
import { constructEvent, WebhookSignatureError } from "@cardos/sdk/webhooks";

app.post("/hooks/cardos", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = await constructEvent({
      payload: req.body,                  // the raw Buffer
      headers: req.headers,
      secret: process.env.CARDOS_WEBHOOK_SECRET!,
    });
  } catch (err) {
    // Bad signature, tampered body, or older than 5 minutes → never retry it.
    return res.status(err instanceof WebhookSignatureError ? 400 : 500).end();
  }

  res.json({ received: true });           // ack fast, then do the slow work
  await queue.push(event);
});
```

**Hono / Workers / Next.js route handlers** — `req.text()` is already raw, and a `Headers`
instance works directly:

```ts
app.post("/hooks/cardos", async (c) => {
  const event = await constructEvent({
    payload: await c.req.text(),
    headers: c.req.raw.headers,
    secret: c.env.CARDOS_WEBHOOK_SECRET,
  });
  return c.json({ received: true });
});
```

`WebhookEvent` is a discriminated union on `event`, so `data` narrows per branch:

```ts
switch (event.event) {
  case "purchase.fulfilled":
    for (const item of event.data.items ?? []) {
      console.log(item.name, item.value_usd, item.card_id);
    }
    break;
  case "purchase.refunded":
    refundInApp(event.data.purchase_id);
    break;
  case "deposit.credited":
    credit(event.data.deposit_id, event.data.amount_usdc);
    break;
}
event.delivery_id;  // X-Mystery-Delivery — dedupe on this
event.timestamp;    // X-Mystery-Timestamp, as unix ms
```

One registry serves both products, so `WEBHOOK_EVENT_TYPES` exports every event:

- **Partner** ([catalogue](https://business.getcardos.com/gacha-docs/webhooks-guide)) —
  `deposit.credited`, `purchase.reserved|submitted|fulfilled|refunded|failed`,
  `instant_purchase.reserved|submitted|fulfilled|refunded|failed`,
  `buyback.confirmed|transfer_held|card_transferred|transfer_failed`,
  `redemption.prepared|updated`, `pool.item_pulled`, `sellback.confirmed`,
  `payout.statement_ready`, `payout.paid`.
- **Card Data** ([catalogue](https://business.getcardos.com/docs/webhooks)) —
  `card.price_updated`, `card.added`, `card.updated`, `expansion.released`,
  `sealed.price_updated`, `population.updated`. Register `card.price_updated` with filters:
  unfiltered it is a firehose.

`sellback.*` and `payout.*` are TIER-model events; `buyback.*` and `pool.item_pulled` belong to
the legacy POOL model and don't fire on a TIER account. `payout.statement_ready` and `payout.paid`
carry the whole frozen statement, and `sellback.confirmed` the `token_ids`, `total_usdc` and
`transaction_hash`, so your ledger can mirror ours from the webhook alone.

`purchase.fulfilled` carries the revealed `items[]` inline so you rarely need to call back,
but hydration is best-effort — fall back to `cardos.gacha.getPurchase(id)` when the key is
absent. `instant_purchase.fulfilled` carries the whole serialized purchase, `cards` included.

Just need the boolean?

```ts
import { verifyWebhookSignature } from "@cardos/sdk/webhooks";

await verifyWebhookSignature({
  payload: rawBody,                       // string or Uint8Array — the exact bytes
  signature: headers["x-mystery-signature"]!,
  secret,
  toleranceMs: 300_000,                   // default 5 minutes; 0 disables the freshness check
});
```

It resolves `true` or throws `WebhookSignatureError` with a message saying which check
failed — it never resolves `false`, so a forgotten `await` cannot pass silently.

## Pagination

Docs: [Search & filtering](https://business.getcardos.com/docs/search) ·
[Best practices](https://business.getcardos.com/docs/best-practices)

Two page types, both `AsyncIterable` over **items**, not pages:

- `OffsetPage<T>` — the partner API (`limit` / `offset` / `has_more`)
- `NumberedPage<T>` — Card Data (`page` / `page_size` / `total_count`)

```ts
const page = await cardos.gacha.listPurchases({ status: "FULFILLED", limit: 100 });

page.items;                 // this page
page.hasMore;
const next = await page.next();   // the next page, or null

for await (const purchase of page) {   // walks every page, fetching lazily
  console.log(purchase.id, purchase.price_usdc);
}

const everything = await page.all();   // drain into one array
```

`all()` and `for await` keep fetching until the server says stop, so bound them: the partner
API caps `offset` at 10 000 and Card Data caps `page × page_size` at 10 000. Narrow the
query rather than paging deeper.

## Errors

Docs: [Errors](https://business.getcardos.com/docs/errors)

Every response uses one envelope, so failures look the same across every API. Each failed HTTP
call throws a `CardOSError` (or a subclass keyed by status). Branch on `err.code` — the stable
machine string the wire calls `error` — not on `err.message`, which is for humans and may change.
`5xx` responses never leak internal detail.

| Class | Status | Typical `code` |
|---|---|---|
| `ValidationError` | 400 | `invalid_tier`, `invalid_query`, `invalid_address`, `tx_unverified` |
| `AuthenticationError` | 401 | `unauthorized` — missing / invalid / expired key |
| `InsufficientFundsError` | 402 | `insufficient_funds` (end user's wallet balance), `insufficient_credits` (your Card Data balance) |
| `PermissionError` | 403 | missing scope, or a non-partner key |
| `NotFoundError` | 404 | `not_found`, `token_not_found`, `value_unknown` (on `/price`) |
| `ConflictError` | 409 | `sold_out`, `idempotency_mismatch`, `redemption_exists`, `webhook_limit` |
| `UnprocessableError` | 422 | shape accepted, semantics rejected |
| `RateLimitError` | 429 | `rate_limited` — see `retryAfterMs` |
| `ServiceUnavailableError` | 503 | `overloaded`, `timeout`, `relayer_disabled`, `instant_disabled` |
| `ServerError` | 5xx | `internal_error` |

Non-HTTP failures have their own classes, so a `catch` can tell "the API said no" from "we
never heard back": `ConnectionError`, `TimeoutError`, `PollTimeoutError`, `TerminalStateError`,
`WebhookSignatureError`.

```ts
import {
  CardOSError, ConflictError, InsufficientFundsError, RateLimitError,
} from "@cardos/sdk";

try {
  await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });
} catch (err) {
  if (err instanceof InsufficientFundsError) return topUp(user);
  if (err instanceof ConflictError && err.code === "sold_out") return offerAnotherTier();
  if (err instanceof RateLimitError) return retryAfter(err.retryAfterMs ?? 1000);
  if (err instanceof CardOSError) {
    console.error(err.status, err.code, err.message, err.requestId, err.details);
  }
  throw err;
}
```

Every `CardOSError` carries `status`, `code`, `message`, `details`, `requestId`,
`retryAfterMs`, `retryable`, and the `method` / `path` that failed. `toJSON()` gives you a
loggable object.

**Retries.** The client retries automatically on 429, 502+ and network errors, honouring
`Retry-After`, with jittered exponential backoff — for GETs, DELETEs, and POSTs that carry an
idempotency key (which money-moving POSTs do by default). Default `maxRetries: 2`; set it to
`0` to handle retries yourself. A POST without an idempotency key is never retried.

## Idempotency

Docs: [Custodial purchase](https://business.getcardos.com/gacha-docs/purchases/purchase-custodial)

The custodial purchase endpoint *requires* an `Idempotency-Key`; the SDK mints one for every
money-moving POST — `gacha.purchase`, `instant.purchase`, `redemption.prepare` — when you don't
pass one:

```ts
// The SDK mints a UUID per call.
await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });

// Or own it — mint one when the user taps buy, and reuse it across retries.
await cardos.gacha.purchase({
  tier_id: 3,
  external_user_id: user.id,
  idempotency_key: intentId,
});
```

Re-sending the same key returns the original `202` instead of double-charging. A key is bound to
its first (user, tier) pair, so reusing one with a different `tier_id` is a
`409 idempotency_mismatch`. Mint per (user, tier, intent) — e.g. a UUID minted when the user taps
buy — and hold onto it for the length of your retry loop. `newIdempotencyKey()` is exported if you
want to mint one yourself.

One pack per call: `quantity` is fixed at 1, and anything else is a `400 unsupported_quantity`.
A multi-pull is N sequential calls, each with its **own** key.

## Polling

Every `waitFor*` helper takes the same options:

```ts
await cardos.gacha.waitForReveal(purchase.id, {
  intervalMs: 1_500,      // first gap between polls
  maxIntervalMs: 5_000,   // cap as it backs off
  backoffFactor: 1.5,
  timeoutMs: 120_000,     // give up after this long
  signal: ac.signal,
  onPoll: (value, attempt) => console.log(attempt, (value as Purchase).status),
});
```

They resolve with the final resource, throw `TerminalStateError` (with `.state` and `.value`,
so you can read `failure_reason`) when it settles into a failure state, and `PollTimeoutError`
(with `.lastValue`) when they give up. Defaults: 1 500 ms → 5 000 ms, 120 s timeout —
except `instant.waitForDelivery`, which allows 180 s because fulfilment can take ~90 s.

Polling is for a foreground "opening…" experience. For anything server-side, use
[webhooks](#webhooks).

## Environments & rate limits

Docs: [Rate limits](https://business.getcardos.com/docs/rate-limits) ·
[Gacha overview](https://business.getcardos.com/gacha-docs)

| Environment | Origin | Chain |
|---|---|---|
| `production` | `https://api.getcardos.com` | Base mainnet |
| `staging` | `https://staging-service.rip.fun` | Base Sepolia (sandbox) |

`https://service.rip.fun` is an alias of the production origin — both serve the same API, and
older examples use the rip.fun name. Every route lives under `/api/v1`.

**Partner API (Gacha + Instant Pack): 240 requests/minute per key.** Underneath it, global
concurrency semaphores shared between the two products — 24 reads, 5 purchases, 10 writes,
10 wallet reads. A short burst beyond those queues briefly for a free slot; only a sustained
overload sheds, with `503` + `Retry-After: 1`. Size your client for sequential calls with modest
parallelism and honour `Retry-After` on both statuses.

**Card Data: 300 requests/minute per key**, on a rolling 60-second window, flat for every plan
and independent of your credit balance — throughput is never a plan differentiator. Every
response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a 429 adds
`Retry-After`, which the client honours. 429s and 503 overload shedding happen before metering, so
they are never billed.

Some cached partner reads — `gacha.catalog`, `gacha.odds`, `gacha.price`, the pool-wide feeds —
accept `{ fresh: true }` to force a recompute. Leave it off for normal polling; `gacha.price` is
cached ~60 s. Forcing a recompute is itself rate-limited more tightly than the ordinary read,
so treat it as an escape hatch, not a polling mode.

Pagination limits: partner API `limit` 1–100 (default 50), `offset` 0–10 000; Card Data
`page_size` 1–100 (default 100), `page × page_size` ≤ 10 000.

## TypeScript notes

- **Field names are the API's own.** `snake_case`, no camelCase mirrors. `value_usd` stays
  `value_usd`, `price_usdc` stays `price_usdc`. What you read in the docs is what you type.
- **Money is a string, never a JSON number.** `UsdcString` (`"12.500000"`) and `MicrosString`
  (`"12500000"`) are both `string`. Fields suffixed `_micros` are integer USDC micros; `_usdc`
  is the same value as a decimal string for display; a reveal item's `value_usd` is a USD
  decimal from market pricing. Never `Number()` any of them — use a decimal library for
  arithmetic.
- **Ids follow the wire.** `tier_id`, `purchase_id` and other row ids are numbers; `token_id`,
  `request_id` and `card_id` are strings. Timestamps are ISO-8601 strings, addresses 0x-hex.
- **Statuses are string-literal unions**, so a `switch` is exhaustive and a typo is a compile
  error.
- **Nullability is deliberate.** A field the server always serialises but may leave empty is
  `| null`; a field that can be absent from the payload is `?`. Card Data omits absent values,
  so its optional fields are `?`.
- **No `any`** in any exported signature.
- Both entry points ship ESM and CJS with `.d.ts`:
  `@cardos/sdk` and `@cardos/sdk/webhooks`.
- Types are exported alongside the client — `import type { Purchase, Card, WebhookEvent } from "@cardos/sdk"`.

## Examples

Runnable sketches live in [`examples/`](./examples):

| File | What it shows |
|---|---|
| [`sell-a-pack.ts`](./examples/sell-a-pack.ts) | gacha, both custody models: catalog → purchase (or prepare/submit) → reveal → collection |
| [`sell-an-instant-pack.ts`](./examples/sell-an-instant-pack.ts) | self-custody instant pack: catalog → prepare → the user sends → submit → delivery |
| [`sellback-and-revenue.ts`](./examples/sellback-and-revenue.ts) | quote → prepare → the holder sends → submit, then terms / summary / payouts |
| [`redeem-card.ts`](./examples/redeem-card.ts) | quote → prepare → the holder sends → submit → track |
| [`webhook-handler.ts`](./examples/webhook-handler.ts) | register a webhook, verify deliveries (raw body, Express and Hono) |
| [`browse-catalog.ts`](./examples/browse-catalog.ts) | Card Data search grammar, prices, paging |

Every sample in this README is mirrored in one of them, so `pnpm typecheck` — which covers
`examples/` — proves the whole document compiles against the shipped types.

## License

MIT
