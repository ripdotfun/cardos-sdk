/**
 * Buy a pull back into the pool, then read what you earned on it.
 *
 *   CARDOS_API_KEY=rip_v1_… npx tsx examples/sellback-and-revenue.ts 0xHolder 10231 10232
 *
 * Sell-back is the combo pool's own loop, not a marketplace trade: the pack
 * price already deposited the buyback float on-chain, the holder sells the card
 * straight back out of it, and the card restocks the pool it came from. Nothing
 * is fronted and nothing is owed — the sale simply reduces the net revenue your
 * share is calculated on.
 *
 * https://business.getcardos.com/gacha-docs/flows
 * https://business.getcardos.com/gacha-docs/revenue-payouts/revenue-summary
 */

import { CardOS, ConflictError } from "../src/index.js";

const cardos = new CardOS({ apiKey: process.env.CARDOS_API_KEY! });

const [holder = "0x0000000000000000000000000000000000000000", ...tokenIds] =
  process.argv.slice(2);
const token_ids = tokenIds.length > 0 ? tokenIds : ["10231", "10232"];

/** Stand-in for your wallet layer — the HOLDER's, not yours. */
declare function sendCalls(calls: Array<{ to: string; data: string }>): Promise<string>;

async function main(): Promise<void> {
  // 1. Quote. Max 50 tokens per batch, priced exactly the way the contract
  //    prices it. Two rules the contract enforces and this pre-flights: only
  //    the card's ORIGINAL RECIPIENT may sell it back, and only before its
  //    buyback window expires.
  const quote = await cardos.sellback.quote({ wallet_address: holder, token_ids });
  for (const item of quote.items) {
    console.log(
      item.eligible
        ? `  ${item.token_id}: ${item.payout_usdc} USDC (window closes ${item.expires_at})`
        : `  ${item.token_id}: ineligible — ${item.reason}`,
    );
  }
  if (quote.eligible_token_ids.length === 0) return;
  if (!quote.sufficient_liquidity) {
    // The contract checks this too, so a false here is a revert you can avoid.
    console.error(`Pool liquidity is ${quote.pool_liquidity_usdc} USDC — try again later.`);
    return;
  }
  console.log(`Total payout: ${quote.total_payout_usdc} USDC`);

  // 2. Prepare. The batch is all-or-nothing on-chain, so send only the eligible
  //    subset. calls[] is a one-time set-approval-for-all (included ONLY when
  //    it is actually missing — the pool moves the card itself during the sale)
  //    then the sale. Dispatch on `call.kind`, never on the description.
  const prep = await cardos.sellback.prepare({
    wallet_address: holder,
    token_ids: quote.eligible_token_ids,
    slippage_bps: 100, // 1%, the default — the pool re-reads the oracle at execution time
  });
  for (const call of prep.calls) console.log(`  ${call.kind}: ${call.description}`);
  console.log(`floor ${prep.min_total_usdc} USDC`);

  // 3. The holder sends them from their own wallet and is paid USDC on the
  //    spot. The card transfers into the pool and is restocked.
  const transaction_hash = await sendCalls(prep.calls);

  // 4. Record it. The amount is decoded from the on-chain event, never from
  //    this request, because it is the deduction in your net revenue. CardOS
  //    indexes the same event independently, so re-submitting is safe.
  try {
    const record = await cardos.sellback.submit({ transaction_hash, wallet_address: holder });
    console.log(`sellback ${record.sellback_id}: ${record.total_usdc} USDC`);
  } catch (err) {
    if (err instanceof ConflictError) {
      console.error(`Rejected: ${err.code}`, err.details);
      return;
    }
    throw err;
  }

  const history = await cardos.sellback.list({ limit: 20 });
  for (const r of history.items) {
    console.log(`  ${r.sellback_id} ${r.token_ids.length} card(s) ${r.total_usdc} USDC`);
  }

  // 5. What you earn. Rates are negotiated per product and can change, so read
  //    them rather than hardcoding: closing a period FREEZES its figures and
  //    its rates, so a later renegotiation only affects future periods.
  const terms = await cardos.revenue.terms();
  console.log(
    `\n${terms.plan} — ${terms.revenue_share_pct}% of tier net, ` +
      `${terms.instant_revenue_share_pct}% on instant, paid ${terms.payout_schedule} ` +
      `in ${terms.payout_currency}`,
  );

  const summary = await cardos.revenue.summary({ from: "2026-07-01", to: "2026-10-01" });
  // gross − sell backs − fees = net; your share is each product's net at its own rate.
  console.log(
    `gross ${summary.gross_usdc} − sellbacks ${summary.sellback_usdc} ` +
      `− fees ${summary.fees_usdc} = net ${summary.net_usdc}`,
  );
  console.log(`your share: ${summary.revenue_share_usdc} USDC`);
  console.log(`  tier:    ${summary.by_product.tier.share_usdc} @ ${summary.by_product.tier.share_bps} bps`);
  console.log(`  instant: ${summary.by_product.instant.share_usdc} @ ${summary.by_product.instant.share_bps} bps`);

  // Closed statements, newest first, plus what is still owed.
  const payouts = await cardos.revenue.payouts({ limit: 20 });
  for (const p of payouts.items) {
    console.log(`  ${p.period.from}–${p.period.to} ${p.status} ${p.net_usdc} net`);
  }
  const owed = await cardos.revenue.outstanding();
  console.log(`outstanding ${owed.outstanding_usdc} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
