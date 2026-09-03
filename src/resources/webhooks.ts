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
   * read it back. Omit `event_types` entirely to receive every event; an
   * unknown name anywhere in the array rejects the whole registration with a
   * `400 invalid_event_types` naming the ones it did not recognise.
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
   * Use it to confirm a subscription after registering, or to check which event
   * types an endpoint is on before you change them. No signing secret is ever
   * returned here — it is shown once, at registration, and nowhere else. Throws
   * `NotFoundError` (404) when no webhook with that id is on your key.
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
