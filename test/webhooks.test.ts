import { describe, expect, it } from "vitest";
import { NotFoundError, WebhookSignatureError } from "../src/index.js";
import type { WebhookDelivery, WebhookRegistration } from "../src/index.js";
import {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  WEBHOOK_EVENT_TYPES,
  constructEvent,
  isWebhookEventType,
  verifyWebhookSignature,
} from "../src/webhooks.js";
import { fail, makeClient, mockFetch, ok } from "./helpers.js";

const SECRET = "b6f0c2e4a1d938475f6c0b2e4a1d93847b6f0c2e4a1d938475f6c0b2e4a1d9384";

/** The server's signing scheme, re-implemented here so the test signs for real. */
async function sign(body: string, secret: string, t: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},sha256=${hex}`;
}

const NOW = 1_772_000_000_000;

const FULFILLED = JSON.stringify({
  event: "purchase.fulfilled",
  id: "purchase.fulfilled:5012",
  data: {
    purchase_id: 5012,
    status: "FULFILLED",
    onchain_request_id: "0xabc",
    items: [
      {
        token_id: "10231",
        item_type: "CARD",
        category: "card",
        card_id: "swsh7-215",
        name: "Umbreon VMAX",
        image_url: "https://images.rip.fun/swsh7-215.png",
        value_usd: "412.50",
        rarity: "Secret Rare",
        card_number: "215",
        set_id: "swsh7",
      },
    ],
  },
});

describe("verifyWebhookSignature", () => {
  it("accepts a signature the server would have produced", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    await expect(
      verifyWebhookSignature({ payload: FULFILLED, signature, secret: SECRET, now: NOW }),
    ).resolves.toBe(true);
  });

  it("accepts a Uint8Array payload (raw body bytes)", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const bytes = new TextEncoder().encode(FULFILLED);
    await expect(
      verifyWebhookSignature({ payload: bytes, signature, secret: SECRET, now: NOW }),
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const tampered = FULFILLED.replace('"412.50"', '"4120.50"');
    await expect(
      verifyWebhookSignature({ payload: tampered, signature, secret: SECRET, now: NOW }),
    ).rejects.toThrow(WebhookSignatureError);
    await expect(
      verifyWebhookSignature({ payload: tampered, signature, secret: SECRET, now: NOW }),
    ).rejects.toThrow(/signature mismatch/i);
  });

  it("rejects a signature made with a different secret", async () => {
    const signature = await sign(FULFILLED, `${SECRET.slice(0, -1)}0`, NOW);
    await expect(
      verifyWebhookSignature({ payload: FULFILLED, signature, secret: SECRET, now: NOW }),
    ).rejects.toThrow(/signature mismatch/i);
  });

  it("rejects a stale timestamp beyond the 5 minute tolerance", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const later = NOW + DEFAULT_WEBHOOK_TOLERANCE_MS + 1_000;
    await expect(
      verifyWebhookSignature({ payload: FULFILLED, signature, secret: SECRET, now: later }),
    ).rejects.toThrow(/too old/i);
    // Inside the window it still verifies.
    await expect(
      verifyWebhookSignature({
        payload: FULFILLED,
        signature,
        secret: SECRET,
        now: NOW + DEFAULT_WEBHOOK_TOLERANCE_MS - 1_000,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a timestamp far in the future, and honours toleranceMs: 0", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW + 600_000);
    await expect(
      verifyWebhookSignature({ payload: FULFILLED, signature, secret: SECRET, now: NOW }),
    ).rejects.toThrow(/future/i);
    await expect(
      verifyWebhookSignature({
        payload: FULFILLED,
        signature,
        secret: SECRET,
        now: NOW,
        toleranceMs: 0,
      }),
    ).resolves.toBe(true);
  });

  it("rejects malformed signature headers", async () => {
    const cases = [
      "",
      "nonsense",
      "sha256=deadbeef",
      `t=${NOW}`,
      `t=abc,sha256=${"a".repeat(64)}`,
      `t=${NOW},sha256=tooshort`,
      `t=${NOW},sha256=${"z".repeat(64)}`,
    ];
    for (const signature of cases) {
      await expect(
        verifyWebhookSignature({ payload: FULFILLED, signature, secret: SECRET, now: NOW }),
      ).rejects.toBeInstanceOf(WebhookSignatureError);
    }
  });

  it("requires a secret", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    await expect(
      verifyWebhookSignature({ payload: FULFILLED, signature, secret: "", now: NOW }),
    ).rejects.toThrow(/secret is required/i);
  });
});

describe("constructEvent", () => {
  it("returns a typed event from a Headers instance", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const headers = new Headers({
      "X-Mystery-Event": "purchase.fulfilled",
      "X-Mystery-Delivery": "purchase.fulfilled:5012",
      "X-Mystery-Timestamp": String(NOW),
      "X-Mystery-Signature": signature,
    });
    const event = await constructEvent({
      payload: FULFILLED,
      headers,
      secret: SECRET,
      now: NOW,
    });
    expect(event.event).toBe("purchase.fulfilled");
    expect(event.id).toBe("purchase.fulfilled:5012");
    expect(event.delivery_id).toBe("purchase.fulfilled:5012");
    expect(event.timestamp).toBe(NOW);
    if (event.event === "purchase.fulfilled") {
      expect(event.data.purchase_id).toBe(5012);
      expect(event.data.items?.[0]?.value_usd).toBe("412.50");
      expect(event.data.items?.[0]?.card_id).toBe("swsh7-215");
    } else {
      throw new Error("expected purchase.fulfilled");
    }
  });

  it("reads headers case-insensitively from a plain record", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const event = await constructEvent({
      payload: FULFILLED,
      // Node's `req.headers` shape, plus a mixed-case key to prove the lookup.
      headers: {
        "x-mystery-delivery": "purchase.fulfilled:5012",
        "X-Mystery-Timestamp": String(NOW),
        "x-mystery-signature": signature,
      },
      secret: SECRET,
      now: NOW,
    });
    expect(event.event).toBe("purchase.fulfilled");
    expect(event.timestamp).toBe(NOW);
    expect(event.delivery_id).toBe("purchase.fulfilled:5012");
  });

  it("accepts a bare `signature` and falls back to the signed `t` for the timestamp", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    const event = await constructEvent({
      payload: FULFILLED,
      signature,
      secret: SECRET,
      now: NOW,
    });
    expect(event.timestamp).toBe(NOW);
    expect(event.delivery_id).toBe("purchase.fulfilled:5012");
  });

  it("narrows every documented event's data by name", async () => {
    const body = JSON.stringify({
      event: "sellback.confirmed",
      id: "sellback.confirmed:0xdead",
      data: {
        sellback_id: 44,
        seller: "0x1111111111111111111111111111111111111111",
        token_ids: ["10231", "10232"],
        total_usdc: "35.700000",
        transaction_hash: "0xdead",
      },
    });
    const signature = await sign(body, SECRET, NOW);
    const event = await constructEvent({ payload: body, signature, secret: SECRET, now: NOW });
    if (event.event !== "sellback.confirmed") throw new Error("bad narrowing");
    expect(event.data.total_usdc).toBe("35.700000");
    expect(event.data.token_ids).toEqual(["10231", "10232"]);
  });

  it("keeps an unrecognised event instead of dropping it", async () => {
    const body = JSON.stringify({ event: "future.event", id: "future.event:1", data: { x: 1 } });
    const signature = await sign(body, SECRET, NOW);
    const event = await constructEvent({ payload: body, signature, secret: SECRET, now: NOW });
    expect(event.event).toBe("future.event");
    expect(isWebhookEventType(event.event)).toBe(false);
  });

  it("throws on a tampered body before it ever parses JSON", async () => {
    const signature = await sign(FULFILLED, SECRET, NOW);
    await expect(
      constructEvent({
        payload: FULFILLED.replace("5012", "9999"),
        signature,
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toThrow(WebhookSignatureError);
  });

  it("throws when the signature header is absent entirely", async () => {
    await expect(
      constructEvent({ payload: FULFILLED, headers: {}, secret: SECRET, now: NOW }),
    ).rejects.toThrow(/Missing webhook signature/i);
  });

  it("throws on a verified body that is not the `{ event, id, data }` envelope", async () => {
    const body = JSON.stringify({ id: "x", data: {} });
    const signature = await sign(body, SECRET, NOW);
    await expect(
      constructEvent({ payload: body, signature, secret: SECRET, now: NOW }),
    ).rejects.toThrow(/missing the `event` field/i);
  });

  it("exports every documented event type, across both products", () => {
    // 21 Gacha / Instant Pack events + 6 Card Data events.
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(27);
    expect(WEBHOOK_EVENT_TYPES).toContain("purchase.fulfilled");
    expect(WEBHOOK_EVENT_TYPES).toContain("payout.paid");
    expect(WEBHOOK_EVENT_TYPES).toContain("card.price_updated");
    expect(WEBHOOK_EVENT_TYPES).toContain("population.updated");
    expect(isWebhookEventType("pool.item_pulled")).toBe(true);
    expect(isWebhookEventType("expansion.released")).toBe(true);
    expect(isWebhookEventType("nope")).toBe(false);
  });

  it("narrows a Card Data event's data by name", async () => {
    const body = JSON.stringify({
      event: "card.price_updated",
      id: "card.price_updated:swsh7-215",
      data: {
        card_id: "swsh7-215",
        game: "pokemon",
        previous: 380.0,
        current: 412.5,
        change_pct: 8.55,
        condition: "NM",
      },
    });
    const signature = await sign(body, SECRET, NOW);
    const event = await constructEvent({ payload: body, signature, secret: SECRET, now: NOW });
    if (event.event !== "card.price_updated") throw new Error("bad narrowing");
    expect(event.data.card_id).toBe("swsh7-215");
    expect(event.data.change_pct).toBe(8.55);
  });
});

describe("cardos.webhooks", () => {
  const registration = {
    id: 3,
    url: "https://partner.example/hooks/rip",
    event_types: ["purchase.fulfilled"],
    is_active: true,
    created_at: "2026-09-01T00:00:00.000Z",
  } satisfies WebhookRegistration;

  it("register POSTs url + event_types and returns the one-time secret", async () => {
    const fx = mockFetch([
      { status: 201, body: { success: true, data: { ...registration, signing_secret: "a".repeat(64) } } },
    ]);
    const c = makeClient(fx);
    const hook = await c.webhooks.register({
      url: "https://partner.example/hooks/rip",
      event_types: ["purchase.fulfilled", "purchase.refunded"],
    });
    expect(fx.last.method).toBe("POST");
    expect(fx.last.url.pathname).toBe("/api/v1/webhooks");
    expect(fx.last.body).toEqual({
      url: "https://partner.example/hooks/rip",
      event_types: ["purchase.fulfilled", "purchase.refunded"],
    });
    expect(hook.signing_secret).toHaveLength(64);
    expect(hook.id).toBe(3);
  });

  it("register forwards Card Data filters when given", async () => {
    const fx = mockFetch([
      { status: 201, body: { success: true, data: { ...registration, signing_secret: "c".repeat(64) } } },
    ]);
    await makeClient(fx).webhooks.register({
      url: "https://partner.example/hooks/rip",
      event_types: ["card.price_updated"],
      filters: { game: "pokemon", min_change_pct: 5 },
    });
    expect(fx.last.body).toEqual({
      url: "https://partner.example/hooks/rip",
      event_types: ["card.price_updated"],
      filters: { game: "pokemon", min_change_pct: 5 },
    });
  });

  it("register omits event_types entirely when not given (subscribe to everything)", async () => {
    const fx = mockFetch([
      { status: 201, body: { success: true, data: { ...registration, event_types: [], signing_secret: "b".repeat(64) } } },
    ]);
    const c = makeClient(fx);
    await c.webhooks.register({ url: "https://partner.example/hooks/rip" });
    expect(fx.last.body).toEqual({ url: "https://partner.example/hooks/rip" });
  });

  it("register surfaces the 409 webhook_limit conflict", async () => {
    const fx = mockFetch([fail(409, "webhook_limit", "Webhook limit reached (20)")]);
    const c = makeClient(fx);
    await expect(
      c.webhooks.register({ url: "https://partner.example/hooks/rip" }),
    ).rejects.toMatchObject({ status: 409, code: "webhook_limit" });
  });

  it("list unwraps data.webhooks", async () => {
    const fx = mockFetch([ok({ webhooks: [registration] })]);
    const c = makeClient(fx);
    const hooks = await c.webhooks.list();
    expect(fx.last.method).toBe("GET");
    expect(fx.last.url.pathname).toBe("/api/v1/webhooks");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.url).toBe("https://partner.example/hooks/rip");
  });

  it("get unwraps data.webhook and maps 404 to NotFoundError", async () => {
    const fx = mockFetch([ok({ webhook: registration }), fail(404, "not_found", "Webhook not found")]);
    const c = makeClient(fx);
    const hook = await c.webhooks.get(3);
    expect(fx.last.url.pathname).toBe("/api/v1/webhooks/3");
    expect(hook.id).toBe(3);
    await expect(c.webhooks.get(999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("delete sends DELETE and returns { id, deleted }", async () => {
    const fx = mockFetch([ok({ id: 3, deleted: true })]);
    const c = makeClient(fx);
    const res = await c.webhooks.delete(3);
    expect(fx.last.method).toBe("DELETE");
    expect(fx.last.url.pathname).toBe("/api/v1/webhooks/3");
    expect(res).toEqual({ id: 3, deleted: true });
  });

  it("deliveries returns an OffsetPage that walks to the next page", async () => {
    const row = (id: number): WebhookDelivery => ({
      id,
      webhook_id: 3,
      event_type: "purchase.fulfilled",
      event_id: `purchase.fulfilled:${id}`,
      status: "DELIVERED",
      attempts: 1,
      last_status_code: 200,
      last_error: null,
      next_retry_at: null,
      delivered_at: "2026-09-01T00:00:01.000Z",
      created_at: "2026-09-01T00:00:00.000Z",
    });
    const fx = mockFetch([
      ok({ deliveries: [row(1), row(2)] }, { pagination: { limit: 2, offset: 0, has_more: true } }),
      ok({ deliveries: [row(3)] }, { pagination: { limit: 2, offset: 2, has_more: false } }),
    ]);
    const c = makeClient(fx);
    const page = await c.webhooks.deliveries({ limit: 2 });
    expect(fx.last.url.pathname).toBe("/api/v1/webhooks/deliveries");
    expect(fx.last.url.searchParams.get("limit")).toBe("2");
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const next = await page.next();
    expect(fx.last.url.searchParams.get("offset")).toBe("2");
    expect(next?.items[0]?.id).toBe(3);
    expect(next?.hasMore).toBe(false);
  });

  it("deliveries drains every page with all()", async () => {
    const fx = mockFetch([
      ok({ deliveries: [{ id: 1 }] }, { pagination: { limit: 1, offset: 0, has_more: true } }),
      ok({ deliveries: [{ id: 2 }] }, { pagination: { limit: 1, offset: 1, has_more: false } }),
    ]);
    const c = makeClient(fx);
    const all = await (await c.webhooks.deliveries({ limit: 1 })).all();
    expect(all.map((d) => d.id)).toEqual([1, 2]);
  });
});
