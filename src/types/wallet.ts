/**
 * Types for `cardos.wallet` — the end user's custodial USDC credits wallet
 * behind `/api/v1/wallet/*`.
 *
 * Money appears twice on every row: an integer-micros string (`amount`,
 * `available`, …) and a decimal twin (`amount_usdc`, `available_usdc`, …).
 * Do arithmetic on the micros, display the decimals, and never `Number()`
 * either of them.
 */

import { OffsetPage } from "../pagination.js";
import type {
  Address,
  IsoDate,
  MicrosString,
  OffsetPagination,
  TxHash,
  UsdcString,
} from "./common.js";

/** The end user a wallet call resolved to. */
export interface WalletEndUser {
  /** CardOS's own id for this end user. */
  id: number;
  external_user_id: string | null;
  wallet_address: Address | null;
}

/**
 * The credits themselves. `available` is what a new purchase can reserve;
 * `reserved` is held by in-flight purchases and released on refund;
 * `balance` is the sum.
 */
export interface WalletCredits {
  /** Always `"USDC"` today. */
  currency: string;
  available: MicrosString;
  reserved: MicrosString;
  balance: MicrosString;
  available_usdc: UsdcString;
  reserved_usdc: UsdcString;
  balance_usdc: UsdcString;
}

/** `GET /wallet/balance` — the resolved end user plus their credit balances. */
export interface WalletBalance {
  end_user: WalletEndUser;
  wallet: WalletCredits;
}

/**
 * What moved the balance.
 *
 * `DEPOSIT_CREDIT` funds arrived · `HOLD` a purchase reserved funds ·
 * `HOLD_RELEASE` a reservation was returned · `HOLD_SETTLE` a reservation was
 * spent · `BUYBACK_CREDIT` a buyback paid out · `REFUND_CREDIT` a failed
 * purchase was refunded · `ADJUSTMENT` a manual correction.
 */
export type LedgerEntryType =
  | "DEPOSIT_CREDIT"
  | "HOLD"
  | "HOLD_RELEASE"
  | "HOLD_SETTLE"
  | "BUYBACK_CREDIT"
  | "REFUND_CREDIT"
  | "ADJUSTMENT";

/** One row of the wallet's audit trail, newest first. */
export interface LedgerEntry {
  id: number;
  entry_type: LedgerEntryType;
  /** Signed USDC micros: credits to available are positive, debits and holds negative. */
  amount: MicrosString;
  amount_usdc: UsdcString;
  /** Running balances after this entry; `null` when they were not recorded. */
  balance_after: MicrosString | null;
  reserved_after: MicrosString | null;
  /** What caused the entry, e.g. `deposit`, `purchase`, `buyback`. */
  source: string | null;
  /** The cause's own id — with `source`, this reads as e.g. `purchase:123`. */
  source_id: string | null;
  description: string | null;
  created_at: IsoDate;
}

/** Deposit confirmation state. The wallet is credited on `CONFIRMED`. */
export type DepositStatus =
  | "PENDING"
  | "SEEN"
  | "PROCESSING"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED";

/** One on-chain deposit CardOS has seen for this end user. */
export interface Deposit {
  id: number;
  /** Source chain, e.g. `base`, `ethereum`, `polygon`. */
  chain_in: string;
  /** Source token, e.g. `USDC`, `ETH`. */
  token_in: string;
  /** Human-readable amount of `token_in` — not micros. */
  amount: string;
  tx_hash: TxHash | null;
  status: DepositStatus;
  /** Expected USDC on Base once bridged. */
  expected_output: string | null;
  created_at: IsoDate;
  confirmed_at: IsoDate | null;
}

/** `POST /wallet/deposit-address` — where an end user tops their wallet up. */
export interface DepositAddress {
  /** Chain to send on, e.g. `base`. */
  chain: string;
  address: Address;
  /** Always `"USDC"`. */
  currency: string;
  /**
   * `true` = a per-end-user address, credited automatically.
   * `false` = the shared fallback address; read `note` for how attribution works.
   */
  dedicated: boolean;
  /** Only present on the shared (`dedicated: false`) address. */
  note?: string;
}

/**
 * An `OffsetPage<Deposit>` that also carries the two wallet-level facts
 * `GET /wallet/deposits` returns beside the rows.
 *
 * `linked_internal_user` is the one that matters: when it is `false` the page
 * is empty because the end user has no linked deposit identity yet — not
 * because they never deposited. Same subclassing choice as `CollectionPage`,
 * so the flags survive `next()`.
 */
export class DepositPage extends OffsetPage<Deposit> {
  constructor(
    /** The end user's credits wallet id. */
    readonly wallet_id: number,
    /** `false` → no linked deposit identity yet, so `items` is empty. */
    readonly linked_internal_user: boolean,
    items: Deposit[],
    pagination: OffsetPagination,
    fetchPage: (offset: number) => Promise<DepositPage>,
  ) {
    super(items, pagination, fetchPage);
  }

  override next(): Promise<DepositPage | null> {
    return super.next() as Promise<DepositPage | null>;
  }
}
