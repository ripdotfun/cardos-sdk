/**
 * Sell one instant pack — a real booster pack bought AND opened in a single
 * on-chain transaction, self-custody.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/sell-an-instant-pack.ts 0xUserWallet
 *
 * The end user holds their own funds and their own cards: `prepare` hands you
 * the transactions, THEY send them from their own wallet, and you record the
 * hash. CardOS never touches their funds, and the cards deliver straight to
 * that wallet.
 *
 * https://business.getcardos.com/instant-docs
 */

import { CardOS, ConflictError, PollTimeoutError } from "../src/index.js";

const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });

const userWallet = process.argv[2] ?? "0x0000000000000000000000000000000000000000";

/** Stand-in for your wallet layer (privy, viem, an AA bundler, …). */
declare function sendCalls(calls: Array<{ to: string; data: string }>): Promise<string>;

async function main(): Promise<void> {
  // 1. What's on the shelf? `available_packs` is live inventory — CardOS rips
  //    real packs and records each one's cards as a pre-built bundle.
  const packs = await cardos.instant.catalog({ include_unavailable: false, limit: 20 });
  const pack = packs.items[0];
  if (!pack) throw new Error("No instant packs available right now.");
  console.log(
    `${pack.name} (${pack.set_id}) — ${pack.price_usdc} USDC, ${pack.available_packs} left`,
  );

  // 2. Prepare. Creates nothing; returns the transactions for the END USER.
  //    Instant calls carry NO `kind` discriminator (unlike redemption and
  //    sell-back): dispatch on position — calls[0] is the USDC approve,
  //    calls[1] the buy-and-open. Under account abstraction send the approve
  //    as its own userop, and skip it when the allowance already covers it.
  const prep = await cardos.instant.prepare({
    wallet_address: userWallet,
    packet_type_id: pack.packet_type_id,
    max_price_usdc: pack.price_usdc, // never pay more than we quoted them
  });
  for (const call of prep.calls) console.log(`  ${call.description}`);

  // 3. The user sends them. Signing a message would do nothing on-chain.
  const transaction_hash = await sendCalls(prep.calls);

  // 4. Record the hash so CardOS can track the delivery.
  let purchase;
  try {
    purchase = await cardos.instant.submit({
      wallet_address: userWallet,
      packet_type_id: pack.packet_type_id,
      transaction_hash,
    });
  } catch (err) {
    // available_packs hit 0 between the catalog read and the purchase.
    if (err instanceof ConflictError && err.code === "sold_out") {
      console.error("Sold out — re-read the catalog and offer another pack.");
      return;
    }
    throw err;
  }
  console.log(`instant purchase ${purchase.id} — ${purchase.status}`);

  // 5. Delivery is asynchronous: usually a few seconds, up to ~90 s while the
  //    VRF settles, so waitForDelivery allows 180 s. In production take the
  //    `instant_purchase.fulfilled` webhook instead and use this for the UI.
  try {
    const delivered = await cardos.instant.waitForDelivery(purchase.id);
    console.log(`\nopened ${delivered.pack?.name ?? "pack"}:`);
    for (const card of delivered.cards ?? []) {
      const chase = card.is_chase ? " ★" : "";
      console.log(`  ${card.name ?? card.token_id} — $${card.value_usd ?? "—"}${chase}`);
    }
  } catch (err) {
    if (err instanceof PollTimeoutError) {
      console.error("Still settling — poll instant.getPurchase(id) or wait for the webhook.");
      return;
    }
    throw err;
  }

  // Everything this user has bought, newest first:
  const history = await cardos.instant.listPurchases({ wallet_address: userWallet, limit: 10 });
  for (const p of history.items) {
    console.log(`  ${p.id} ${p.status} ${p.price_usdc} USDC`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
