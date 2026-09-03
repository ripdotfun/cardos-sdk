/**
 * `@cardos/sdk/webhooks` — verify and parse incoming webhook deliveries.
 *
 * A separate entry point from the main barrel so a request handler can import
 * just this (no HTTP client, no resources). Everything here is Web Crypto
 * (`globalThis.crypto.subtle`), so the same code runs on Node ≥ 20, Bun, Deno,
 * Cloudflare Workers, Vercel Edge and the browser — there is no `node:crypto`
 * import anywhere in this file.
 *
 *     import { constructEvent } from "@cardos/sdk/webhooks";
 *
 *     const event = await constructEvent({
 *       payload: rawBody,               // the EXACT bytes, not JSON.parse'd
 *       headers: req.headers,
 *       secret: process.env.CARDOS_WEBHOOK_SECRET!,
 *     });
 *
 * The documented signature scheme:
 *
 *     X-Mystery-Signature: t=<unix_ms>,sha256=<hex>
 *     hex = HMAC_SHA256(signing_secret, `${t}.${rawBody}`)
 *
 * `t` doubles as the freshness stamp: deliveries older (or newer) than
 * `toleranceMs` are rejected, which bounds how long a captured delivery can be
 * replayed. Dedupe on `X-Mystery-Delivery` (`event.delivery_id`) — delivery is
 * at-least-once and a non-2xx is retried up to 6 attempts with exponential
 * backoff, so a slow consumer WILL see the same event id twice.
 */

import { WebhookSignatureError } from "./errors.js";
import { isWebhookEventType } from "./types/webhooks.js";
import type {
  WebhookConstructEventOptions,
  WebhookEvent,
  WebhookHeadersInput,
  WebhookVerifyOptions,
} from "./types/webhooks.js";

export type {
  WebhookAnyEvent,
  WebhookConstructEventOptions,
  WebhookEvent,
  WebhookEventType,
  WebhookHeadersInput,
  WebhookUnknownEvent,
  WebhookVerifyOptions,
} from "./types/webhooks.js";
export { WEBHOOK_EVENT_TYPES, isWebhookEventType } from "./types/webhooks.js";
export { WebhookSignatureError } from "./errors.js";

/** Default freshness window: 5 minutes, the documented replay tolerance. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 300_000;

/** Header the signature arrives in. */
export const WEBHOOK_SIGNATURE_HEADER = "x-mystery-signature";
/** Header carrying the event name. */
export const WEBHOOK_EVENT_HEADER = "x-mystery-event";
/** Header carrying the delivery / event id — dedupe on this. */
export const WEBHOOK_DELIVERY_HEADER = "x-mystery-delivery";
/** Header carrying the signed unix-ms timestamp. */
export const WEBHOOK_TIMESTAMP_HEADER = "x-mystery-timestamp";

const encoder = new TextEncoder();

/**
 * Verify one delivery's `X-Mystery-Signature`.
 *
 * Resolves `true` on a good signature; throws `WebhookSignatureError` with a
 * specific message otherwise (malformed header, stale timestamp, mismatch), so
 * a handler can log *why* it rejected. It never resolves `false` — a boolean
 * return that is only ever `true` keeps `if (!await verify(...))` from silently
 * passing when someone forgets the `await`.
 *
 * @param opts.payload   the EXACT raw body bytes/string. `JSON.parse` +
 *                       `JSON.stringify` re-orders and re-spaces the JSON and
 *                       will fail verification.
 * @param opts.signature the `X-Mystery-Signature` header value.
 * @param opts.secret    the `signing_secret` from `cardos.webhooks.register()`.
 * @param opts.toleranceMs freshness window in ms (default 300 000; `0` skips it).
 */
export async function verifyWebhookSignature(opts: WebhookVerifyOptions): Promise<boolean> {
  const { payload, signature, secret } = opts;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new WebhookSignatureError("Webhook secret is required to verify a signature");
  }
  if (typeof signature !== "string" || signature.length === 0) {
    throw new WebhookSignatureError(
      `Missing webhook signature — expected the ${headerName(WEBHOOK_SIGNATURE_HEADER)} header`,
    );
  }

  const parsed = parseSignatureHeader(signature);
  const toleranceMs = opts.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  if (toleranceMs > 0) {
    const now = opts.now ?? Date.now();
    const age = now - parsed.timestamp;
    if (age > toleranceMs) {
      throw new WebhookSignatureError(
        `Webhook timestamp is too old: ${age}ms > toleranceMs ${toleranceMs}ms (t=${parsed.timestamp}). ` +
          `Reject it as a replay, or raise toleranceMs if your clock is behind.`,
      );
    }
    if (-age > toleranceMs) {
      throw new WebhookSignatureError(
        `Webhook timestamp is ${-age}ms in the future, beyond toleranceMs ${toleranceMs}ms (t=${parsed.timestamp}). Check your system clock.`,
      );
    }
  }

  const expected = await hmacSha256Hex(secret, signedPayload(parsed.timestamp, payload));
  if (!timingSafeEqualHex(expected, parsed.signature)) {
    throw new WebhookSignatureError(
      "Webhook signature mismatch — the body was modified in transit, or it was signed with a different secret. " +
        "Make sure you pass the RAW request body (not a re-serialised object).",
    );
  }
  return true;
}

/**
 * Verify a delivery and return the typed event.
 *
 * Pass `headers` (a `Headers` instance or a plain record — lookup is
 * case-insensitive) and the signature, delivery id and timestamp are read for
 * you; or pass `signature` directly when your framework already gave you the
 * header. Throws `WebhookSignatureError` on a bad signature, a stale timestamp,
 * or a body that is not the documented `{ event, id, data }` envelope.
 *
 * The result is a discriminated union — `switch (event.event)` narrows
 * `event.data` to that event's payload.
 */
export async function constructEvent(
  opts: WebhookConstructEventOptions,
): Promise<WebhookEvent> {
  const headerSignature = opts.headers
    ? getHeader(opts.headers, WEBHOOK_SIGNATURE_HEADER)
    : undefined;
  const signature = opts.signature ?? headerSignature;
  if (!signature) {
    throw new WebhookSignatureError(
      `Missing webhook signature — pass \`signature\`, or \`headers\` containing ${headerName(WEBHOOK_SIGNATURE_HEADER)}`,
    );
  }

  const verifyOpts: WebhookVerifyOptions = {
    payload: opts.payload,
    signature,
    secret: opts.secret,
  };
  if (opts.toleranceMs !== undefined) verifyOpts.toleranceMs = opts.toleranceMs;
  if (opts.now !== undefined) verifyOpts.now = opts.now;
  await verifyWebhookSignature(verifyOpts);

  const text = toText(opts.payload);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WebhookSignatureError(
      "Webhook payload is not valid JSON (the signature verified, so the body arrived intact — check for double-decoding)",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WebhookSignatureError(
      "Webhook payload is not an object — expected `{ event, id, data }`",
    );
  }

  const raw = body as { event?: unknown; id?: unknown; data?: unknown };
  if (typeof raw.event !== "string" || raw.event.length === 0) {
    throw new WebhookSignatureError(
      "Webhook payload is missing the `event` field — expected `{ event, id, data }`",
    );
  }
  // An unknown name is NOT an error: a newer server may emit an event this SDK
  // version has no literal for, and dropping it would lose a real delivery. It
  // is returned as-is — guard with `isWebhookEventType(event.event)` (or widen
  // to `WebhookAnyEvent`) if you deploy against a newer API than this release.
  void isWebhookEventType(raw.event);

  const event: Record<string, unknown> = {
    event: raw.event,
    id: typeof raw.id === "string" ? raw.id : "",
    data: raw.data && typeof raw.data === "object" ? raw.data : {},
  };

  if (opts.headers) {
    const deliveryId = getHeader(opts.headers, WEBHOOK_DELIVERY_HEADER);
    if (deliveryId) event.delivery_id = deliveryId;
    const ts = getHeader(opts.headers, WEBHOOK_TIMESTAMP_HEADER);
    if (ts !== undefined) {
      const n = Number(ts);
      if (Number.isFinite(n)) event.timestamp = n;
    }
  }
  if (event.timestamp === undefined) {
    event.timestamp = parseSignatureHeader(signature).timestamp;
  }
  if (!event.delivery_id && event.id) event.delivery_id = event.id as string;

  return event as unknown as WebhookEvent;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ParsedSignature {
  timestamp: number;
  signature: string;
}

/** Parse `t=<unix_ms>,sha256=<hex>`. Order-insensitive; extra parts ignored. */
function parseSignatureHeader(header: string): ParsedSignature {
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && timestamp === undefined) {
      if (!/^\d+$/.test(value)) break;
      timestamp = Number(value);
    } else if (key === "sha256" && signature === undefined) {
      signature = value;
    }
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || signature === undefined) {
    throw new WebhookSignatureError(
      `Malformed webhook signature header ${JSON.stringify(header)} — expected "t=<unix_ms>,sha256=<hex>"`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(signature) || signature.length !== 64) {
    throw new WebhookSignatureError(
      "Malformed webhook signature header — `sha256=` must be 64 hex characters",
    );
  }
  return { timestamp, signature };
}

/** `"<t>.<raw_body>"` as bytes, without stringifying binary payloads. */
function signedPayload(timestamp: number, payload: string | Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.`);
  const bodyBytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const out = new Uint8Array(prefix.length + bodyBytes.length);
  out.set(prefix, 0);
  out.set(bodyBytes, prefix.length);
  return out;
}

function toText(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : new TextDecoder().decode(payload);
}

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new WebhookSignatureError(
      "Web Crypto is unavailable (globalThis.crypto.subtle). Node 20+, Deno, Bun, Workers and browsers all provide it; " +
        "on older Node, `globalThis.crypto = require('node:crypto').webcrypto` before calling.",
    );
  }
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // Cast: `Uint8Array<ArrayBufferLike>` (what a caller's raw body is) is not
  // structurally assignable to TS 5.7+'s `BufferSource`, though it is one.
  const sig = await subtle.sign("HMAC", key, message as unknown as BufferSource);
  return hex(new Uint8Array(sig));
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Constant-time compare of two hex strings. Length is compared first (it is not
 * secret — both are always 64 chars), then every character is XOR-accumulated
 * so the loop never short-circuits on the first differing byte.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  let diff = 0;
  for (let i = 0; i < lowerA.length; i++) {
    diff |= lowerA.charCodeAt(i) ^ lowerB.charCodeAt(i);
  }
  return diff === 0;
}

/** Case-insensitive header read across `Headers` and plain records. */
function getHeader(headers: WebhookHeadersInput, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  // Fast path: the lowercase key Node's `req.headers` already uses.
  const direct = record[name];
  const found =
    direct !== undefined
      ? direct
      : Object.entries(record).find(([k]) => k.toLowerCase() === name)?.[1];
  if (found === undefined) return undefined;
  // Node collapses repeats into an array for some headers; take the first.
  return Array.isArray(found) ? found[0] : found;
}

/** `x-mystery-signature` → `X-Mystery-Signature`, for readable messages. */
function headerName(lower: string): string {
  return lower
    .split("-")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join("-");
}
