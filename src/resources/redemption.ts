/**
 * `cardos.redemption` — physical redemption: ship the real card, burn the NFT.
 *
 * Who signs what: only the WALLET HOLDING THE TOKEN can start a redemption.
 * `prepare()` returns unsigned calldata — the redemption burn flag, then a USDC
 * approve and a `payShipping` call carrying a server-signed quote — and the END
 * USER broadcasts all of it from that wallet. You never sign, and you are never
 * billed for shipping. `submit()` records the hash; the item ships once that
 * shipping payment is on-chain, and the token burns at dispatch.
 *
 * CardOS runs no KYC/AML on your end users — screening them is your
 * responsibility.
 */

import { newIdempotencyKey } from "../http.js";
import type { OffsetPage } from "../pagination.js";
import { poll, type PollOptions } from "../polling.js";
import type {
  Redemption,
  RedemptionGetParams,
  RedemptionListParams,
  RedemptionPrepareParams,
  RedemptionPrepareResult,
  RedemptionQuoteParams,
  RedemptionShippingQuote,
  RedemptionSubmitParams,
  RedemptionSubmitResult,
} from "../types/redemption.js";
import { Resource } from "./base.js";

/** Physical fulfilment is slow — a completion poll needs real headroom. */
const DEFAULT_COMPLETION_TIMEOUT_MS = 600_000;

/** Terminal failures shared by both `waitFor*` helpers. */
function failedState(r: Redemption): string | false {
  return r.status === "FAILED" || r.status === "CANCELLED" || r.status === "EXPIRED"
    ? r.status
    : false;
}

export class RedemptionResource extends Resource {
  /**
   * A pre-checkout shipping quote. Creates nothing, so it is safe to call just
   * to show the shipping cost before the user commits.
   *
   * `POST /api/v1/mystery/redemption/quote` — scope `cards:redeem`.
   * Validates the address through Shippo and returns the cheapest live rate.
   * Supply `purchase_id` OR `token_id` (`token_id` alone is a token-first /
   * own-gacha redemption; with `purchase_id` it disambiguates a multi-item
   * purchase).
   *
   * Notable errors: 400 `purchase_or_token_required` /
   * `missing_shipping_address` / `invalid_address` / `phone_required` (a
   * non-US destination needs a phone number), 404 `token_not_found` /
   * `not_found`, 409 `not_fulfilled` / `ambiguous_token` /
   * `item_type_mismatch` / `no_holder`.
   */
  quote(params: RedemptionQuoteParams): Promise<RedemptionShippingQuote> {
    const { overrides, rest } = this.split(params);
    return this.http
      .data<{ shipping_quote: RedemptionShippingQuote }>({
        ...overrides,
        method: "POST",
        path: "/api/v1/mystery/redemption/quote",
        body: rest,
      })
      .then((d) => d.shipping_quote);
  }

  /**
   * Start a redemption: store the address, lock in the cheapest shipping rate,
   * and return the calls the END USER signs.
   *
   * `POST /api/v1/mystery/redemption/prepare` — scope `cards:redeem`.
   * `unsigned.calls` come back in the order they must be sent: `burn` (flags
   * the token for redemption), `erc20-approve` (USDC → the shipping processor;
   * its own userop under account abstraction), then `shipping-payment`
   * (`payShipping`, which verifies the burn state, so it must run after the
   * burn). `shipping_payment` echoes the signed quote so you can show it
   * without decoding calldata. Everything is valid until `expires_at`
   * (default 24 h); an `EXPIRED` redemption is retryable with a new
   * idempotency key.
   *
   * An `Idempotency-Key` is generated unless you pass `idempotency_key`.
   * Idempotent on (partner, key); at most one live redemption per
   * (partner, token).
   *
   * CardOS runs no KYC/AML — run whatever screening you need on the end user
   * before you call this.
   *
   * Notable errors: 400 `purchase_or_token_required` /
   * `missing_shipping_address` / `invalid_address` / `phone_required` /
   * `invalid_shipping_payer`, 404 `token_not_found`, 409 `not_fulfilled` /
   * `redemption_exists` / `not_burnable` / `not_owner` / `no_holder` /
   * `ambiguous_token` / `item_type_mismatch` / `invalid_token_id`,
   * 503 `shipping_signer_unavailable`.
   */
  prepare(params: RedemptionPrepareParams): Promise<RedemptionPrepareResult> {
    const { overrides, rest } = this.split(params);
    const { idempotency_key, ...body } = rest as Record<string, unknown> & {
      idempotency_key?: string;
    };
    return this.http.data<RedemptionPrepareResult>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/redemption/prepare",
      body,
      idempotencyKey: idempotency_key ?? newIdempotencyKey(),
    });
  }

  /**
   * Record the burn transaction the holder already broadcast
   * (`PREPARED` → `BURN_SUBMITTED`, 202).
   *
   * `POST /api/v1/mystery/redemption/submit` — scope `cards:redeem`.
   * This records a hash; it sends nothing, and re-submitting the same hash is
   * safe.
   *
   * Notable errors: 400 `invalid_tx_hash`, 404 `not_found`, 409 `invalid_status`
   * (the redemption is not `PREPARED`).
   */
  submit(params: RedemptionSubmitParams): Promise<RedemptionSubmitResult> {
    const { overrides, rest } = this.split(params);
    return this.http.data<RedemptionSubmitResult>({
      ...overrides,
      method: "POST",
      path: "/api/v1/mystery/redemption/submit",
      body: rest,
    });
  }

  /**
   * Every redemption for a purchase or a token, newest first.
   *
   * `GET /api/v1/mystery/redemption/{purchase_id}` — scope `packs:read`.
   * The path segment accepts a purchase id OR an on-chain token id: a value
   * that is not one of your purchases resolves token-first (which is how
   * own-gacha redemptions, whose `purchase_id` is `null`, are read).
   * `verify: true` checks the card's status live on-chain instead of cached.
   *
   * 404 `not_found` when the purchase or token has no redemptions.
   */
  get(
    purchaseIdOrToken: number | string,
    params?: RedemptionGetParams,
  ): Promise<Redemption[]> {
    const { overrides, rest } = this.split(params);
    return this.http
      .data<{ redemptions: Redemption[] }>({
        ...overrides,
        method: "GET",
        path: `/api/v1/mystery/redemption/${encodeURIComponent(String(purchaseIdOrToken))}`,
        query: { verify: rest.verify },
      })
      .then((d) => d.redemptions ?? []);
  }

  /**
   * Partner-wide redemption history, newest first.
   *
   * `GET /api/v1/mystery/redemptions` — scope `packs:read`.
   * 400 `invalid_status` for a status outside the lifecycle.
   */
  list(params?: RedemptionListParams): Promise<OffsetPage<Redemption>> {
    const { overrides, rest } = this.split(params);
    const { limit, offset, ...query } = rest;
    return this.offsetPage<Redemption>(
      { ...overrides, path: "/api/v1/mystery/redemptions", query },
      "redemptions",
      { limit, offset },
    );
  }

  /**
   * Poll until a redemption reaches `COMPLETED`.
   *
   * Accepts a token id (or purchase id) or a {@link RedemptionPrepareResult} —
   * pass the prepare result and the right row is picked out by
   * `redemption_id`, which matters because `get()` returns every redemption
   * for the id you gave it.
   *
   * Physical fulfilment is slow — picking, packing, carrier hand-off — so the
   * default `timeoutMs` is 10 minutes and even that will usually expire. The
   * `redemption.*` webhooks are the right tool for tracking a real shipment;
   * this exists for scripts and tests. Throws `TerminalStateError` on
   * `FAILED` / `CANCELLED` / `EXPIRED`.
   */
  waitForCompletion(
    target: string | number | RedemptionPrepareResult,
    pollOpts: PollOptions = {},
  ): Promise<Redemption> {
    return this.pollRedemption(
      target,
      (r) => r.status === "COMPLETED",
      "complete",
      { timeoutMs: DEFAULT_COMPLETION_TIMEOUT_MS, ...pollOpts },
    );
  }

  /** Shared machinery behind the `waitFor*` helpers. */
  private pollRedemption(
    target: string | number | RedemptionPrepareResult,
    isDone: (r: Redemption) => boolean,
    goal: string,
    pollOpts: PollOptions,
  ): Promise<Redemption> {
    const prepared = typeof target === "object" ? target : null;
    // `get()` takes a purchase id or a token id, so poll on the token id the
    // prepare result carries rather than its redemption_id.
    const lookup = prepared ? prepared.token_id : String(target);
    const wanted = prepared ? prepared.redemption_id : null;

    return poll<Redemption>(
      {
        label: `redemption ${lookup} to ${goal}`,
        fetch: async () => {
          const rows = await this.get(lookup, { signal: pollOpts.signal });
          const row =
            (wanted != null ? rows.find((r) => r.redemption_id === wanted) : undefined) ??
            rows[0];
          if (!row) {
            throw new Error(`No redemption found for ${lookup}`);
          }
          return row;
        },
        isDone,
        isFailed: failedState,
      },
      pollOpts,
    );
  }
}
