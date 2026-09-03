# Changelog

All notable changes to `@ripdotfun/cardos-sdk` are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.2 — 2026-09-03

Realigned with the docs site, which now publishes several things 0.1.1 had
withheld and withdraws several it had described.

Restored, now that the reference covers them:

- `{ fresh: true }` on the cached partner reads (`gacha.catalog`, `gacha.games`,
  `gacha.odds`, `gacha.price` and the three feeds). It bypasses the shared
  response cache on its own budget of 10 calls per minute per key — a manual
  refresh, not a polling mode.
- `webhooks.get(id)` — `GET /api/v1/webhooks/{id}`, one registration without its
  signing secret.
- `revenue.outstanding()` with `RevenueOutstanding` / `RevenueAccrual`: the
  unpaid statements plus `accruing`, your live share of activity no statement
  covers yet, and `total_owed_usdc`.

Aligned with the corrected reference:

- **Webhooks.** `WEBHOOK_EVENT_TYPES` is back to the 21 live partner events. The
  six catalog events (`card.price_updated`, `card.added`, `card.updated`,
  `expansion.released`, `sealed.price_updated`, `population.updated`) and the
  `filters` registration parameter are documented ahead of their launch and
  rejected today with `400 invalid_event_types`, so their event types, payload
  types, union members and the `WebhookFilters` type are removed. A delivery
  carrying an unknown event still parses, as `WebhookUnknownEvent`.
- **Card Data errors.** `invalid_query` never existed. The real codes are
  `parse_error`, `unknown_field`, `invalid_value`, `query_too_complex`,
  `invalid_select`, `invalid_include`, `invalid_pagination`, `invalid_language`,
  `invalid_distinct` and `not_found`, and the first three carry
  `details.position`.
- **Card Data pricing.** `CardPricingCondition` is `{ condition, price }` only —
  `low`, `high` and `sold_count` are gone. `trend_7d` is the only trend window;
  `trend_30d` / `trend_90d` are gone. `pricing` is present for every card under
  `include: "prices"`, empty rather than dropped.

BREAKING for anyone who had adopted the catalog webhook events, the pre-launch
`filters` parameter, or the pricing fields listed above; all of them are absent
from the live API.

## 0.1.1 — 2026-09-03

- Removed `buyback.createForPurchase()`, `buyback.get()`, `webhooks.get()`,
  `revenue.outstanding()` and the `fresh` option: none of them are part of the
  published API reference. Use `buyback.create()`, `buyback.offers()`,
  `webhooks.list()` and `revenue.payouts()`.
- Source maps are no longer shipped in the package.

## 0.1.0 — 2026-09-03

Initial public release.

- Typed client for the CardOS partner APIs: gacha tiers and odds, purchases
  (custodial and self-custody `prepare` / `submit`), instant packs, custodial
  wallets, sell-back, physical redemption, and revenue share and payouts.
- Card Data catalog: cards, expansions, sealed products, printings and market
  prices for Pokémon, One Piece and Azuki, with the `q` search grammar.
- Webhook signature verification in a separate `@ripdotfun/cardos-sdk/webhooks` entry
  point, built on Web Crypto so it runs unchanged on Node, Bun, Deno, Workers
  and Edge.
- Automatic idempotency keys on money-moving POSTs, jittered retries that
  honour `Retry-After`, `waitFor*` polling helpers, and `AsyncIterable`
  pagination over items.
- A typed error hierarchy keyed by status, plus distinct classes for connection,
  timeout, poll-timeout, terminal-state and webhook-signature failures.
- Zero runtime dependencies; ESM + CJS with type declarations for both entry
  points.
