/**
 * `cardos.webhooks` — the webhook registry and its delivery log.
 *
 * This resource only MANAGES subscriptions. Verifying and parsing the
 * deliveries themselves lives in the separate `@ripdotfun/cardos-sdk/webhooks` entry
 * (`verifyWebhookSignature`, `constructEvent`) so a request handler can import
 * the crypto without pulling in the HTTP client.
 *
 * Every route here needs the `webhooks:manage` scope.
 */

import type { OffsetPage } from "../pagination.js";
import type { OffsetPageParams, RequestOverrides } from "../types/common.js";
import type {
  WebhookDeleteResult,
  WebhookDelivery,
  WebhookRegisterParams,
  WebhookRegistration,
  WebhookRegistrationWithSecret,
} from "../types/webhooks.js";
import { Resource } from "./base.js";

const BASE = "/api/v1/webhooks";

export class WebhooksResource extends Resource {
  /**
   * Register a webhook endpoint. `POST /api/v1/webhooks` → 201. Scope `webhooks:manage`.
   *
   * The response is the ONLY time `signing_secret` is ever returned — store it
   * now (it is what `verifyWebhookSignature` needs) because no later call can
   * read it back. Omit `event_types` to receive every event; pass `filters` to
   * narrow the Card Data events an endpoint receives.
   *
   * The URL must be publicly reachable over HTTPS — private, loopback and
   * link-local URLs are rejected. Partners are capped at 20 webhooks, and the
   * 21st is a `409 webhook_limit`.
   */
  async register(
    params: WebhookRegisterParams & RequestOverrides,
  ): Promise<WebhookRegistrationWithSecret> {
    const { overrides, rest } = this.split(params);
    return this.http.data<WebhookRegistrationWithSecret>({
      ...overrides,
      method: "POST",
      path: BASE,
      body: {
        url: rest.url,
        ...(rest.event_types ? { event_types: [...rest.event_types] } : {}),
        ...(rest.filters ? { filters: rest.filters } : {}),
      },
    });
  }

  /**
   * Every webhook registered for this partner. `GET /api/v1/webhooks`. Scope `webhooks:manage`.
   *
   * Signing secrets are never returned after creation, so this is safe to log.
   * Returns a plain array, not a page — a partner is capped at 20 webhooks.
   */
  async list(opts?: RequestOverrides): Promise<WebhookRegistration[]> {
    const { overrides } = this.split(opts);
    const data = await this.http.data<{ webhooks: WebhookRegistration[] }>({
      ...overrides,
      method: "GET",
      path: BASE,
    });
    return data.webhooks ?? [];
  }

  /**
   * One webhook by id. `GET /api/v1/webhooks/{id}`. Scope `webhooks:manage`.
   *
   * Not part of the published API reference — {@link list} is the documented
   * way to read your registrations. No secret is returned. Throws
   * `NotFoundError` (404) for an unknown id or one belonging to another
   * partner.
   */
  async get(id: number, opts?: RequestOverrides): Promise<WebhookRegistration> {
    const { overrides } = this.split(opts);
    const data = await this.http.data<{ webhook: WebhookRegistration }>({
      ...overrides,
      method: "GET",
      path: `${BASE}/${id}`,
    });
    return data.webhook;
  }

  /**
   * Unregister a webhook. `DELETE /api/v1/webhooks/{id}`. Scope `webhooks:manage`.
   *
   * Pending deliveries queued for it are dropped. Throws `NotFoundError` (404)
   * for an unknown id.
   */
  async delete(id: number, opts?: RequestOverrides): Promise<WebhookDeleteResult> {
    const { overrides } = this.split(opts);
    return this.http.data<WebhookDeleteResult>({
      ...overrides,
      method: "DELETE",
      path: `${BASE}/${id}`,
    });
  }

  /**
   * Recent delivery attempts across every webhook, newest first.
   * `GET /api/v1/webhooks/deliveries` → `OffsetPage<WebhookDelivery>`. Scope `webhooks:manage`.
   *
   * The debugging view for a consumer that is not receiving events: `status`,
   * `attempts`, `last_status_code` and `last_error` say what the server saw.
   * A non-2xx response (or a timeout) is retried up to 6 attempts with
   * exponential backoff before the delivery is dropped.
   */
  async deliveries(
    params?: OffsetPageParams & RequestOverrides,
  ): Promise<OffsetPage<WebhookDelivery>> {
    const { overrides, rest } = this.split(params);
    return this.offsetPage<WebhookDelivery>(
      { ...overrides, path: `${BASE}/deliveries` },
      "deliveries",
      rest,
    );
  }
}
