/**
 * Receive CardOS webhooks: register an endpoint, then verify and handle the
 * deliveries.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/webhook-handler.ts register https://you.example/hooks/cardos
 *   CARDOS_WEBHOOK_SECRET=… npx tsx examples/webhook-handler.ts serve
 *
 * The verification half imports from `@ripdotfun/cardos-sdk/webhooks` — a separate entry
 * with no HTTP client in it, implemented on Web Crypto, so the same handler
 * runs on Node, Bun, Deno, Workers and Vercel Edge.
 *
 * https://business.getcardos.com/gacha-docs/webhooks-guide
 */

import { createServer } from "node:http";
import { CardOS } from "../src/index.js";
import { WebhookSignatureError, constructEvent } from "../src/webhooks.js";

// ---------------------------------------------------------------------------
// One-time setup: register the endpoint and store the signing secret.
// ---------------------------------------------------------------------------

async function register(url: string): Promise<void> {
  const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });
  const hook = await cardos.webhooks.register({
    url,
    // Omit `event_types` to receive everything.
    event_types: ["purchase.fulfilled", "purchase.refunded", "purchase.failed"],
  });

  // A 64-hex string, shown exactly ONCE at creation — `list()` never returns
  // secrets. Persist it now. Up to 20 webhooks per partner.
  console.log(`webhook ${hook.id} → ${hook.url}`);
  console.log(`CARDOS_WEBHOOK_SECRET=${hook.signing_secret}`);

  // Later, to debug a consumer that is not receiving events:
  const deliveries = await cardos.webhooks.deliveries({ limit: 5 });
  for (const d of deliveries.items) {
    console.log(`${d.created_at} ${d.event_type} ${d.status} ` +
      `(attempt ${d.attempts}, http ${d.last_status_code ?? "—"}) ${d.last_error ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// The handler. Two rules: use the RAW body, and answer fast.
// ---------------------------------------------------------------------------

const secret = process.env.CARDOS_WEBHOOK_SECRET ?? "";
/** Deliveries retry, so the same event id can arrive more than once. */
const seen = new Set<string>();

async function handle(rawBody: string, headers: Record<string, string | string[] | undefined>) {
  // Throws WebhookSignatureError on a bad signature, a tampered body, or a
  // delivery older than 5 minutes (`toleranceMs`).
  const event = await constructEvent({ payload: rawBody, headers, secret });

  const deliveryId = event.delivery_id ?? event.id;
  if (seen.has(deliveryId)) return; // already processed — ack and move on
  seen.add(deliveryId);

  switch (event.event) {
    case "purchase.fulfilled": {
      // `items` is hydrated best-effort: fall back to gacha.getPurchase(id).
      const { purchase_id, items } = event.data;
      console.log(`purchase ${purchase_id} revealed ${items?.length ?? 0} item(s)`);
      for (const item of items ?? []) {
        console.log(`  ${item.name} — $${item.value_usd} (${item.card_id ?? item.item_type})`);
      }
      break;
    }
    case "purchase.refunded":
      console.log(`purchase ${event.data.purchase_id} refunded — the hold is back`);
      break;
    case "purchase.failed":
      console.log(`purchase ${event.data.purchase_id} failed: ${event.data.reason}`);
      break;
    case "deposit.credited":
      console.log(`credited ${event.data.amount_usdc} USDC (${event.data.tx_hash})`);
      break;
    case "redemption.updated":
      console.log(`redemption ${event.data.redemption_id} → ${event.data.status}`);
      break;
    default:
      console.log(`unhandled ${event.event}`);
  }
}

// --- Node's http server: read the raw bytes, never a JSON body parser -------

function serve(): void {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      handle(raw, req.headers)
        .then(() => res.writeHead(200).end('{"received":true}'))
        .catch((err: unknown) => {
          if (err instanceof WebhookSignatureError) {
            // 400: never retry a forgery.
            console.error(`rejected: ${err.message}`);
            res.writeHead(400).end();
            return;
          }
          // 500: delivery is retried, up to 6 attempts with backoff.
          console.error(err);
          res.writeHead(500).end();
        });
    });
  });
  server.listen(3000, () => console.log("listening on :3000"));
}

/*
 * Express — `express.raw` keeps the bytes the signature was computed over.
 * `express.json()` re-serialises and WILL break verification.
 *
 *   app.post("/hooks/cardos", express.raw({ type: "application/json" }), async (req, res) => {
 *     try {
 *       const event = await constructEvent({ payload: req.body, headers: req.headers, secret });
 *       res.json({ received: true });          // ack first
 *       await enqueue(event);                  // then do the slow work
 *     } catch (err) {
 *       res.status(err instanceof WebhookSignatureError ? 400 : 500).end();
 *     }
 *   });
 *
 * Hono / Workers / Next.js route handlers — `await req.text()` is already raw:
 *
 *   app.post("/hooks/cardos", async (c) => {
 *     const event = await constructEvent({
 *       payload: await c.req.text(),
 *       headers: c.req.raw.headers,            // a Headers instance works too
 *       secret: c.env.CARDOS_WEBHOOK_SECRET,
 *     });
 *     return c.json({ received: true });
 *   });
 */

const [command, arg] = process.argv.slice(2);
if (command === "register" && arg) {
  register(arg).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
} else if (command === "serve") {
  serve();
} else {
  console.error("usage: webhook-handler.ts register <url> | serve");
  process.exitCode = 1;
}
