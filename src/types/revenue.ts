/**
 * Revenue share, commercial terms and payout statements (TIER partners).
 *
 * There is no per-item receivable: CardOS owns the inventory and funds the
 * buyback float, and YOU EARN a share of net revenue
 * (`net = gross − sell backs − fees`) at your negotiated per-product rate,
 * settled in USDC on your payout schedule — quarterly by default.
 */

import type {
  Address,
  IsoDate,
  MicrosString,
  OffsetPageParams,
  RequestOverrides,
  TxHash,
  UsdcString,
} from "./common.js";

/** How the partner is billed. `POOL` partners have no revenue share. */
export type RevenueBillingModel = "TIER" | "POOL";

/** `STANDARD` is paid in USDC on schedule; `ENTERPRISE` is billed. */
export type RevenuePlan = "STANDARD" | "ENTERPRISE";

export type RevenuePayoutSchedule = "QUARTERLY" | "MONTHLY" | "CUSTOM";

/** Settlement state of one closed period. */
export type RevenuePayoutStatus =
  /** Closed, awaiting payment. */
  | "PENDING"
  /** `tx_hash` set. */
  | "PAID"
  | "FAILED"
  /** Settled outside the on-chain rail — an enterprise invoice, say. */
  | "VOID";

/** The combo-tier component of a revenue figure. */
export interface RevenueTierComponent {
  packs: number;
  gross_usdc: UsdcString;
  /** Present on the live summary; absent on a closed statement's tier block. */
  sellback_count?: number;
  sellback_usdc: UsdcString;
  net_usdc: UsdcString;
  share_bps: number;
  share_usdc: UsdcString;
}

/** The instant-pack component. Instant cards never get a buyback window, so no sell-backs. */
export interface RevenueInstantComponent {
  packs: number;
  gross_usdc: UsdcString;
  /** Always `"0.000000"` on the live summary; absent on a closed statement. */
  sellback_usdc?: UsdcString;
  net_usdc: UsdcString;
  share_bps: number;
  share_usdc: UsdcString;
}

export interface RevenueByProduct {
  tier: RevenueTierComponent;
  instant: RevenueInstantComponent;
}

/** Result of `revenue.summary()` — the running numbers for a period. */
export interface RevenueSummary {
  billing_model: RevenueBillingModel | null;
  /** Combo-tier rate in basis points. */
  revenue_share_bps: number | null;
  instant_revenue_share_bps: number | null;
  period: { from: IsoDate | null; to: IsoDate | null };
  /** Each product with its own base, rate and share. */
  by_product: RevenueByProduct;
  /** How many combo packs contributed to gross. */
  qualifying_packs: number;
  instant_packs: number;
  gross_micros: MicrosString;
  /** Paid for qualifying packs in the period. */
  gross_usdc: UsdcString;
  sellback_count: number;
  sellback_micros: MicrosString;
  /** USDC the pool paid back on cards from those packs. */
  sellback_usdc: UsdcString;
  net_micros: MicrosString;
  /** `gross − sell backs − fees`. */
  net_usdc: UsdcString;
  revenue_share_micros: MicrosString;
  /** WHAT YOU EARN — each product's net at its own rate, summed, floored at zero. */
  revenue_share_usdc: UsdcString;
  payout_micros: MicrosString;
  /** Same figure as `revenue_share_usdc`, named as the money movement. */
  payout_usdc: UsdcString;
  rip_retained_micros: MicrosString;
  /** The remainder CardOS keeps, so the statement reconciles to net. */
  rip_retained_usdc: UsdcString;
  fees_micros: MicrosString;
  fees_usdc: UsdcString;
  /** The per-product figures the closed statement is built from. */
  components: {
    tier_gross_micros: MicrosString;
    tier_sellback_micros: MicrosString;
    tier_net_micros: MicrosString;
    tier_share_micros: MicrosString;
    instant_gross_micros: MicrosString;
    instant_net_micros: MicrosString;
    instant_share_micros: MicrosString;
  };
  note: string;
}

/** Result of `revenue.terms()` — your current commercial terms. */
export interface RevenueTerms {
  billing_model: RevenueBillingModel | null;
  plan: RevenuePlan | null;
  revenue_share_bps: number | null;
  /** What you earn of net revenue on combo tier sales, e.g. `"5.00"`. */
  revenue_share_pct: string | null;
  instant_revenue_share_bps: number | null;
  /** What you earn on instant pack sales, e.g. `"1.00"`. */
  instant_revenue_share_pct: string | null;
  payout_schedule: RevenuePayoutSchedule | null;
  /** Always `"USDC"`. */
  payout_currency: string;
  /** Where your share is sent. Set it with `revenue.setPayoutWallet()`. */
  payout_wallet: { chain: string; address: Address } | null;
  /** The period now accruing and when it closes. */
  current_period: {
    kind: RevenuePayoutSchedule;
    from: IsoDate;
    to: IsoDate;
    closes_at: IsoDate;
  } | null;
  note: string;
}

/**
 * One closed period. Closing FREEZES its figures AND its rates, so a statement
 * is a permanent record — renegotiating later changes future periods only.
 */
export interface RevenuePayout {
  payout_id: number;
  period: { kind: RevenuePayoutSchedule; from: IsoDate; to: IsoDate };
  qualifying_packs: number;
  gross_usdc: UsdcString;
  sellback_count: number;
  sellback_usdc: UsdcString;
  /** `gross − sell backs − fees` for that period. */
  net_usdc: UsdcString;
  revenue_share_bps: number;
  revenue_share_pct: string;
  revenue_share_usdc: UsdcString;
  fees_usdc: UsdcString;
  rip_retained_usdc: UsdcString;
  by_product: RevenueByProduct;
  /** What you earned and are paid. */
  payout_usdc: UsdcString;
  payout_micros: MicrosString;
  status: RevenuePayoutStatus;
  payout_address: Address | null;
  chain: string | null;
  tx_hash: TxHash | null;
  paid_at: IsoDate | null;
}

/** The address your revenue share is paid to. */
export interface PayoutWallet {
  /** Defaults to `"base"`. */
  chain: string;
  address: Address;
  is_active: boolean;
  created_at: IsoDate;
}

export interface RevenueSummaryParams extends RequestOverrides {
  /** ISO timestamp. Omit both bounds for all-time. */
  from?: IsoDate;
  /** ISO timestamp, exclusive. */
  to?: IsoDate;
}

export type RevenuePayoutsParams = OffsetPageParams & RequestOverrides;

export interface PayoutWalletGetParams extends RequestOverrides {
  /** Defaults to `"base"`. */
  chain?: string;
}

export interface PayoutWalletSetParams extends RequestOverrides {
  /** Checksum-validated 0x address. */
  address: Address;
  /** Defaults to `"base"`. */
  chain?: string;
}
