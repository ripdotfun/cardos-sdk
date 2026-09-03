/**
 * Page wrappers. Every list method returns one of these; both are
 * `AsyncIterable` over ITEMS (not pages), so
 *
 *     for await (const p of await cardos.gacha.listPurchases({ limit: 100 })) …
 *
 * walks the whole history, fetching pages lazily. `next()` steps one page.
 */

import type { NumberedPagination, OffsetPagination } from "./types/common.js";

export class OffsetPage<T> implements AsyncIterable<T> {
  constructor(
    readonly items: T[],
    readonly pagination: OffsetPagination,
    private readonly fetchPage: (offset: number) => Promise<OffsetPage<T>>,
  ) {}

  get hasMore(): boolean {
    return this.pagination.has_more;
  }

  get nextOffset(): number {
    return this.pagination.next_offset ?? this.pagination.offset + this.pagination.limit;
  }

  /** The next page, or `null` when this is the last one. */
  next(): Promise<OffsetPage<T> | null> {
    return this.hasMore ? this.fetchPage(this.nextOffset) : Promise.resolve(null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: OffsetPage<T> | null = this;
    while (page) {
      yield* page.items;
      page = await page.next();
    }
  }

  /** Drain every remaining page into one array. Mind the 10 000-offset cap. */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}

export class NumberedPage<T> implements AsyncIterable<T> {
  constructor(
    readonly items: T[],
    readonly pagination: NumberedPagination,
    private readonly fetchPage: (page: number) => Promise<NumberedPage<T>>,
  ) {}

  get page(): number {
    return this.pagination.page;
  }
  get pageSize(): number {
    return this.pagination.page_size;
  }
  get totalCount(): number {
    return this.pagination.total_count;
  }
  /** Language filter the server applied (`en` by default, `all`, …). */
  get language(): string | undefined {
    return this.pagination.language;
  }

  get hasMore(): boolean {
    // `total_count` is authoritative; a short page is also a signal.
    return this.page * this.pageSize < this.totalCount && this.items.length === this.pageSize;
  }

  next(): Promise<NumberedPage<T> | null> {
    return this.hasMore ? this.fetchPage(this.page + 1) : Promise.resolve(null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: NumberedPage<T> | null = this;
    while (page) {
      yield* page.items;
      page = await page.next();
    }
  }

  /** Drain every remaining page into one array. `page × page_size` is capped at 10 000 server-side. */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}
