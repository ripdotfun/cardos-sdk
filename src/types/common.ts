/** Shared primitive types used across every resource. */

/** Games covered by the Card Data API. */
export type GameId = "pokemon" | "onepiece" | "azuki";

/** Human decimal USDC string, e.g. `"12.500000"`. Never a number — precision matters. */
export type UsdcString = string;
/** Integer USDC micros (6 dp) as a string, e.g. `"12500000"`. */
export type MicrosString = string;
/** ISO-8601 timestamp. */
export type IsoDate = string;
/** 0x-prefixed EVM address. */
export type Address = string;
/** 0x-prefixed 32-byte transaction hash. */
export type TxHash = string;

/**
 * How the partner identifies an end user on wallet / purchase calls. At least
 * one of the two is required; both may be sent. Snake-case, exactly as the API
 * takes them, so a body can be spread straight through.
 */
export type UserIdentity =
  | { external_user_id: string; wallet_address?: Address }
  | { wallet_address: Address; external_user_id?: string };

/** Gacha-side pagination block (`?limit` / `?offset`). */
export interface OffsetPagination {
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export interface OffsetPageParams {
  /** 1–100, default 50. */
  limit?: number;
  /** 0–10000, default 0. */
  offset?: number;
}

/** Card Data API envelope fields (`?page` / `?page_size`). */
export interface NumberedPagination {
  page: number;
  page_size: number;
  total_count: number;
  /** The language filter the server applied (e.g. `"en"`, `"all"`). */
  language?: string;
}

export interface NumberedPageParams {
  /** ≥ 1, default 1. */
  page?: number;
  /** 1–100, default 100. `page × page_size` ≤ 10 000. */
  page_size?: number;
}

/** Standard success envelope on the Gacha / partner API. */
export interface Envelope<T> {
  success: true;
  data: T;
  pagination?: OffsetPagination;
}

/** Standard success envelope on the Card Data API. */
export interface CatalogEnvelope<T> extends NumberedPagination {
  success: true;
  data: T;
}

/** Standard error envelope on both APIs. */
export interface ErrorEnvelope {
  success: false;
  error: string;
  message?: string;
  details?: unknown;
  retryable?: boolean;
}

/** Per-request overrides accepted by every SDK method. */
export interface RequestOverrides {
  /** Abort the request (and any polling loop it belongs to). */
  signal?: AbortSignal;
  /** Override the client-wide timeout for this call, in ms. */
  timeoutMs?: number;
  /** Extra headers, merged last. */
  headers?: Record<string, string>;
  /** Override the retry policy for this call. */
  maxRetries?: number;
}
