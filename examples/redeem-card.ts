/**
 * Ship a pulled card to the end user: quote → prepare → they send → submit.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/redeem-card.ts 10231
 *
 * Self-custody by construction: only the card's holder can start a redemption,
 * and they pay the quoted shipping in USDC on-chain themselves. `prepare` hands
 * you unsigned calldata and YOUR wallet layer gets the holder to SEND it.
 * Nothing here signs or sends anything.
 *
 * CardOS runs no KYC/AML, so screening your end user is your responsibility —
 * run whatever your jurisdiction and risk policy require, on the current
 * holder, BEFORE you call prepare, and keep the records.
 * https://business.getcardos.com/gacha-docs/flows
 */

import { CardOS, ConflictError } from "../src/index.js";
import type { RedemptionShippingAddress } from "../src/index.js";

const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });

const tokenId = process.argv[2] ?? "10231";

const shipping_address: RedemptionShippingAddress = {
  name: "Ada Lovelace",
  street1: "12 Analytical Way",
  city: "London",
  state: "LDN",
  zip: "EC1A 1AA",
  country: "GB",
  email: "ada@example.com",
};

/** Stand-in for your wallet layer (privy, viem, an AA bundler, …). */
declare function sendCalls(calls: Array<{ to: string; data: string }>): Promise<string>;

async function main(): Promise<void> {
  // 1. What will shipping cost? Creates nothing — safe to call on a checkout
  //    screen while the user edits their address.
  const s = await cardos.redemption.quote({ token_id: tokenId, shipping_address });
  console.log(`${s.carrier} ${s.service}: $${s.amount_usdc}, ~${s.estimated_days} days`);

  // 2. Prepare. Locks that quote (single-use, payer-bound, amount-locked) and
  //    returns the unsigned calls. Auto idempotency key — reusing one with
  //    different params is a 409 idempotency_mismatch.
  let prepared;
  try {
    prepared = await cardos.redemption.prepare({ token_id: tokenId, shipping_address });
  } catch (err) {
    if (err instanceof ConflictError && err.code === "redemption_exists") {
      console.error("Already being redeemed — check redemption.get(tokenId).");
      return;
    }
    throw err;
  }
  console.log(`redemption ${prepared.redemption_id} — ${prepared.status}`);
  const payment = prepared.shipping_payment;
  if (!payment || !prepared.unsigned) {
    // Already past PREPARED — nothing left for the holder to send.
    console.log("nothing to send; check redemption.get(tokenId)");
    return;
  }
  console.log(`shipping ${payment.total_usdc} USDC via ${payment.processor}`);

  // 3. The HOLDER *sends* these as transactions — signing a message does
  //    nothing on-chain. ORDER MATTERS: the redemption flag, then the approve,
  //    then the payment, which only succeeds after the flag call. Under
  //    account abstraction the approve must be its own userop. Dispatch on
  //    `call.kind`, never on the description or the 4-byte selector.
  //    Nothing leaves the wallet here — the card is only flagged, and burns
  //    when the item ships. Expect a plain contract interaction with no token
  //    transfer; that is correct, not a failure.
  for (const call of prepared.unsigned.calls) {
    console.log(`  ${call.kind}: ${call.description}`);
  }
  const tx_hash = await sendCalls(prepared.unsigned.calls);

  // 4. Record the hash. 202 — fulfilment takes over from here. Re-submitting
  //    the same hash is safe.
  const submitted = await cardos.redemption.submit({
    redemption_id: prepared.redemption_id,
    tx_hash,
  });
  console.log(`${submitted.status} — ${submitted.burn_tx_hash}`);

  // 5. Track it. In production subscribe to `redemption.updated` instead of
  //    polling: it fires on every transition after `redemption.prepared`,
  //    through BURN_SUBMITTED → IN_FULFILLMENT → COMPLETED. CardOS ships once
  //    the shipping payment lands on-chain, and burns the card on dispatch.
  const [current] = await cardos.redemption.get(tokenId, { verify: true });
  console.log(`status ${current?.status}, tracking ${current?.order?.tracking_number ?? "pending"}`);

  // Everything in flight, newest first:
  const page = await cardos.redemption.list({ status: "IN_FULFILLMENT", limit: 20 });
  for (const r of page.items) {
    console.log(`  ${r.redemption_id} ${r.token_id} ${r.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
