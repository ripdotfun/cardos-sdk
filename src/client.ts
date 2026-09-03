/**
 * `CardOS` — the client. One API key, every resource hanging off it.
 *
 *     const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });
 *     const purchase = await cardos.gacha.purchase({ tier_id: 3, external_user_id: user.id });
 *     const { items } = await cardos.gacha.waitForReveal(purchase.id);
 */

import { HttpClient } from "./http.js";
import type { ClientContext } from "./resources/base.js";
import { BuybackResource } from "./resources/buyback.js";
import { CardsResource } from "./resources/cards.js";
import { ExpansionsResource } from "./resources/expansions.js";
import { GachaResource } from "./resources/gacha.js";
import { InstantResource } from "./resources/instant.js";
import { RedemptionResource } from "./resources/redemption.js";
import { RevenueResource } from "./resources/revenue.js";
import { SealedResource } from "./resources/sealed.js";
import { SellbackResource } from "./resources/sellback.js";
import { WalletResource } from "./resources/wallet.js";
import { WebhooksResource } from "./resources/webhooks.js";
import type { GameId } from "./types/common.js";

export type CardOSEnvironment = "production" | "staging";

export const ENVIRONMENT_URLS: Record<CardOSEnvironment, string> = {
  /** Base mainnet. `https://service.rip.fun` is the same service under the rip.fun name. */
  production: "https://api.getcardos.com",
  /** Base Sepolia. */
  staging: "https://staging-service.rip.fun",
};

export interface CardOSOptions {
  /** Partner API key (`rip_v1_…`). Sent as `X-API-Key`. */
  apiKey: string;
  /** `production` (default) or `staging`. Ignored when `baseUrl` is set. */
  environment?: CardOSEnvironment;
  /** Override the API origin entirely (local backend, proxy). */
  baseUrl?: string;
  /** Default game for `cards` / `expansions` / `sealed` calls. Default `pokemon`. */
  game?: GameId;
  /** Custom fetch (polyfill, instrumentation, test double). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors for GETs and idempotent POSTs. Default 2. */
  maxRetries?: number;
  /** Extra headers on every request. */
  defaultHeaders?: Record<string, string>;
  /** Override the User-Agent (Node only). */
  userAgent?: string;
}

export class CardOS {
  readonly http: HttpClient;
  readonly options: Readonly<CardOSOptions>;

  /** Mystery packs: catalog, odds, feeds, custodial + non-custodial purchases, reveals, collections, pricing. */
  readonly gacha: GachaResource;
  /** Instant packs: booster packs bought and opened in one on-chain tx. */
  readonly instant: InstantResource;
  /** End-user custodial USDC credits: balances, ledger, deposits, deposit addresses. */
  readonly wallet: WalletResource;
  /** Native combo-pool sell-back (TIER partners): quote, prepare, submit, history. */
  readonly sellback: SellbackResource;
  /** Marketplace buyback offers (token-first and purchase-linked), relayed accept. */
  readonly buyback: BuybackResource;
  /** Physical redemption: shipping quotes, prepare, burn submit, status. */
  readonly redemption: RedemptionResource;
  /** Revenue share: terms, running numbers, statements, payout wallet. */
  readonly revenue: RevenueResource;
  /** Webhook registry + delivery log. Signature verification lives in `@ripdotfun/cardos-sdk/webhooks`. */
  readonly webhooks: WebhooksResource;
  /** Card Data API — cards (search / get / printings / prices). */
  readonly cards: CardsResource;
  /** Card Data API — expansions (search / get / cards). */
  readonly expansions: ExpansionsResource;
  /** Card Data API — sealed products (search / get / prices). */
  readonly sealed: SealedResource;

  constructor(options: CardOSOptions) {
    this.options = Object.freeze({ ...options });
    const baseUrl = options.baseUrl ?? ENVIRONMENT_URLS[options.environment ?? "production"];
    this.http = new HttpClient({
      baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      defaultHeaders: options.defaultHeaders,
      userAgent: options.userAgent,
    });
    const ctx: ClientContext = { game: options.game ?? "pokemon" };

    this.gacha = new GachaResource(this.http, ctx);
    this.instant = new InstantResource(this.http, ctx);
    this.wallet = new WalletResource(this.http, ctx);
    this.sellback = new SellbackResource(this.http, ctx);
    this.buyback = new BuybackResource(this.http, ctx);
    this.redemption = new RedemptionResource(this.http, ctx);
    this.revenue = new RevenueResource(this.http, ctx);
    this.webhooks = new WebhooksResource(this.http, ctx);
    this.cards = new CardsResource(this.http, ctx);
    this.expansions = new ExpansionsResource(this.http, ctx);
    this.sealed = new SealedResource(this.http, ctx);
  }
}
