/**
 * Sell one mystery pack to an end user — both custody models.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/sell-a-pack.ts player-123
 *
 * The whole flow: check the balance, buy the pack, wait for the reveal, print
 * what they pulled. Every value that is money is a string — never `Number()`
 * a price.
 *
 * The custodial path suits users who don't hold wallets. When they do, pass a
 * 0x address as the second argument to take the self-custody path instead:
 *
 *   npx tsx examples/sell-a-pack.ts player-123 0xUserWallet
 *
 * https://business.getcardos.com/gacha-docs/flows
 */

import { CardOS, InsufficientFundsError, TerminalStateError } from "../src/index.js";
import type { Purchase } from "../src/index.js";

const cardos = new CardOS({
  apiKey: process.env.CARDOS_API_KEY!,
  environment: process.env.CARDOS_ENV === "staging" ? "staging" : "production",
});

const externalUserId = process.argv[2] ?? "player-123";
/** Pass a 0x address to take the self-custody path instead of the custodial one. */
const userWallet = process.argv[3];

/** Stand-in for your wallet layer (privy, viem, an AA bundler, …). */
declare function sendCalls(calls: Array<{ to: string; data: string }>): Promise<string>;

/**
 * Self-custody: the end user holds their own funds and their own cards.
 * `prepare` creates nothing — it just returns the transactions to send.
 */
async function selfCustodyBuy(wallet_address: string, tier_id: number): Promise<Purchase> {
  const prep = await cardos.gacha.prepare({ wallet_address, tier_id });
  console.log(`chain ${prep.chain_id}, cap ${prep.max_price_usdc} USDC`);

  // The end user SENDS these (a signature popup does nothing on-chain).
  // Dispatch on `kind` — not the description, not the 4-byte selector. Under
  // account abstraction the erc20-approve must be its own userop, and you can
  // skip it when the allowance already covers max_price.
  for (const call of prep.calls) console.log(`  ${call.kind}: ${call.description}`);
  const transaction_hash = await sendCalls(prep.calls);

  // Record it once mined. The 202 body is the same purchase getPurchase()
  // returns — items included when the reveal already settled — so check
  // `status` before scheduling the first poll.
  return cardos.gacha.submit({ wallet_address, tier_id, transaction_hash });
}

async function main(): Promise<void> {
  // 1. What can we sell? Price, EV, slot count and `active` are read live from
  //    the pool. A null price is TEMPORARILY unavailable, never free and never
  //    a real price — skip it and re-fetch shortly.
  const tiers = await cardos.gacha.catalog({ active: true, game: "pokemon" });
  const tier = tiers.find((t) => t.price_usdc !== null);
  if (!tier) throw new Error("No sellable tier right now — retry shortly.");
  console.log(`Selling "${tier.name}" (tier ${tier.tier_id}) at ${tier.price_display}`);

  // 2/3. Either the user holds their own wallet…
  let purchase: Purchase;
  if (userWallet) {
    purchase = await selfCustodyBuy(userWallet, tier.tier_id);
  } else {
    // …or you fund a CardOS credits wallet for them and buy server-side.
    // `available` is what a new purchase can reserve; `reserved` is held by
    // in-flight purchases and released on refund.
    const { wallet } = await cardos.wallet.balance({ external_user_id: externalUserId });
    console.log(`Balance: ${wallet.available_usdc} USDC available`);

    // 202 — the pack is RESERVED and the on-chain purchase is in flight.
    // Exactly one pack per call; a multi-pull is N calls, each with its OWN
    // key. The SDK mints an Idempotency-Key for you; pass your own
    // (`idempotency_key`) if you mint one per (user, tier) when they tap buy.
    try {
      purchase = await cardos.gacha.purchase({
        tier_id: tier.tier_id,
        external_user_id: externalUserId,
        max_price_usdc: tier.price_usdc!, // never pay more than we quoted them
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        // 402 — top them up and try again.
        const addr = await cardos.wallet.depositAddress({ external_user_id: externalUserId });
        console.error(`Not enough USDC. Deposit to ${addr.address} on ${addr.chain}.`);
        return;
      }
      throw err;
    }
  }
  console.log(`Purchase ${purchase.id} — ${purchase.status} (memo ${purchase.memo})`);

  // 4. Wait for the reveal. It is random and usually takes a few seconds;
  //    polls with backoff and throws TerminalStateError on FAILED / REFUNDED.
  //    In production prefer the `purchase.fulfilled` webhook — see
  //    examples/webhook-handler.ts — and use this only for the "opening…" UI.
  try {
    const revealed = await cardos.gacha.waitForReveal(purchase.id, { timeoutMs: 120_000 });
    console.log(`\n${revealed.status} — pulled ${revealed.items?.length ?? 0} item(s):`);
    for (const item of revealed.items ?? []) {
      console.log(`  ${item.name} — $${item.value_usd} (${item.card_id ?? item.item_type})`);
      console.log(`    ${item.image_url}`);
    }
  } catch (err) {
    if (err instanceof TerminalStateError) {
      // REFUNDED (e.g. the machine was empty) or FAILED (pre-broadcast error).
      // On the custodial path the reserve is released back to their balance.
      const failed = err.value as { failure_reason: string | null };
      console.error(`Purchase ended ${err.state}: ${failed.failure_reason ?? "no reason given"}`);
      return;
    }
    throw err;
  }

  // 5. Their collection, newest first. `still_owned: false` = sold back,
  //    redeemed or transferred away.
  const collection = await cardos.gacha.collection({
    external_user_id: externalUserId,
    limit: 10,
  });
  console.log(`\n${collection.user.external_user_id} owns:`);
  for (const item of collection.items) {
    console.log(`  ${item.name} — $${item.value_usd}${item.still_owned === false ? " (gone)" : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
