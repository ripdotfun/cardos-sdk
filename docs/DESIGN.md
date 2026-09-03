# `@ripdotfun/cardos-sdk` — design notes & contributor guide

TypeScript SDK for the CardOS APIs. Zero runtime dependencies, isomorphic
(Node ≥ 20, browsers, edge runtimes), ESM + CJS via tsup, tests via vitest with
a fake `fetch`.

The experience this package exists for:

```ts
import { CardOS } from "@ripdotfun/cardos-sdk";
const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });

// Sell a pack, filled from real cards in the CardOS vault.
const purchase = await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });
const { items } = await cardos.gacha.waitForReveal(purchase.id);
// → [{ name: 'Umbreon VMAX', value_usd: '412.50', image_url: '…', card_id: 'swsh7-215', … }]
```

## Source of truth

The public docs site at <https://business.getcardos.com> is the contract the SDK
implements:

| Product | Docs |
|---|---|
| Gacha / mystery packs, wallet, sell-back, buyback, redemption, revenue, webhooks | `/gacha-docs` (+ `/gacha-docs/flows`, `/gacha-docs/webhooks-guide`) |
| Instant packs | `/instant-docs` |
| Card Data (cards, expansions, sealed) | `/docs` (+ `/docs/search`, `/docs/pricing`, `/docs/credits`, `/docs/errors`, `/docs/rate-limits`) |

The SDK types and documents what those pages publish. If you find the API
returning something the docs don't describe, file it against the docs rather
than widening the SDK on your own.

## Layout

| File | Provides |
|---|---|
| `src/http.ts` | `HttpClient` — `request<T>()` (full envelope), `data<T>()` (`body.data`), `raw<T>()` (status + headers + body). `X-API-Key`, query encoding (`undefined`/`null` skipped, arrays comma-joined), JSON + `FormData` bodies, `Idempotency-Key`, timeouts, bounded retries (GET/DELETE and POSTs **with** an idempotency key, on 429 / 502+ / network, honouring `Retry-After`). `newIdempotencyKey()`. |
| `src/errors.ts` | `CardOSError` (`status`, `code`, `message`, `details`, `retryAfterMs`, `retryable`) + subclasses per status: `ValidationError` 400, `AuthenticationError` 401, `InsufficientFundsError` 402, `PermissionError` 403, `NotFoundError` 404, `ConflictError` 409, `UnprocessableError` 422, `RateLimitError` 429, `ServiceUnavailableError` 503, `ServerError` 5xx. Non-HTTP: `ConnectionError`, `TimeoutError`, `PollTimeoutError`, `TerminalStateError`, `WebhookSignatureError`. |
| `src/pagination.ts` | `OffsetPage<T>` (`limit/offset/has_more`) and `NumberedPage<T>` (`page/page_size/total_count`). Both are `AsyncIterable<T>` over items, with `next()` and `all()`. |
| `src/polling.ts` | `poll(spec, opts)` — backoff polling behind every `waitFor*`; throws `PollTimeoutError` / `TerminalStateError`. |
| `src/resources/base.ts` | `Resource` base class: `offsetPage()`, `numberedPage()`, `split()` (peels `RequestOverrides` off a params object). |
| `src/resources/*.ts` | One class per surface: `gacha`, `instant`, `wallet`, `sellback`, `buyback`, `redemption`, `revenue`, `webhooks`, `cards`, `expansions`, `sealed`. |
| `src/types/*.ts` | Request/response types per surface, all re-exported from `src/index.ts`. |
| `src/webhooks.ts` | The `@ripdotfun/cardos-sdk/webhooks` entry: `verifyWebhookSignature`, `constructEvent` (Web Crypto, no Node-only imports). |
| `test/helpers.ts` | `mockFetch([...canned])`, `ok()`, `accepted()`, `fail()`, `makeClient()`. |

## Conventions

1. **Field names are the API's.** `snake_case`, no renaming, no camelCase mirrors. The SDK adds ergonomics (polling, pagination, typed errors, defaults), not a second vocabulary.
2. **Partner-API money is strings** (`UsdcString` / `MicrosString`). Never `Number()` a price. Card Data pricing is typed as the docs describe it.
3. **Every public method** has JSDoc with its purpose, HTTP route, required scope, credit cost where metered, and notable error codes — all as published on the docs site.
4. **Params objects, not positional args**, except a single id. Every params object extends `RequestOverrides` (`signal`, `timeoutMs`, `headers`, `maxRetries`).
5. **Lists return `OffsetPage<T>` / `NumberedPage<T>`.** Never a raw array from a list endpoint.
6. **Money-moving POSTs auto-generate an `Idempotency-Key`** unless the caller passes `idempotency_key`. Reusing a key with different params is a 409 `idempotency_mismatch`.
7. **`waitFor*` helpers** wrap `poll()`; terminal failure states throw `TerminalStateError` with the resource attached; the success value is the final resource. They accept `PollOptions`.
8. **Types are precise.** Status enums as string-literal unions. `| null` when the docs say the key is always present but may be null; `?` when the key can be absent.
9. **No `any`** in exported signatures.
10. **Tests** live in `test/<resource>.test.ts` and use the helpers: assert path, method, query, headers and body sent; feed a realistic envelope back; assert the typed result. Cover the happy path, pagination `next()`, one error mapping, and each `waitFor*` (done, failed, timeout).
11. Exported type names are prefixed by surface (`Instant*`, `Sellback*`, `Buyback*`, `Redemption*`, `Revenue*`, `Webhook*`, `Card*`, `Expansion*`, `Sealed*`) or are specific enough not to collide (`Tier`, `Purchase`, `RevealItem`, `WalletBalance`, …), because `src/index.ts` does `export *` from every types file.

## Working on it

```sh
pnpm install
pnpm typecheck   # tsc --noEmit over src, test and examples
pnpm test        # vitest
pnpm build       # tsup → dist/ (esm + cjs + d.ts)
```

`examples/*.ts` are part of the typecheck, so a README sample mirrored there is
proven against the real signatures.
