# Changelog

All notable changes to `@ripdotfun/cardos-sdk` are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
