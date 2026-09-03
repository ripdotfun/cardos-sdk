/**
 * Shared scaffolding for resource classes. Each resource gets the HttpClient
 * plus a small context (default game etc.) and uses the page builders here so
 * every list method paginates the same way.
 */

import type { HttpClient, HttpRequest, Query } from "../http.js";
import { NumberedPage, OffsetPage } from "../pagination.js";
import type {
  CatalogEnvelope,
  Envelope,
  GameId,
  NumberedPageParams,
  OffsetPageParams,
  OffsetPagination,
  RequestOverrides,
} from "../types/common.js";

export interface ClientContext {
  /** Default game for Card Data calls when none is passed per call. */
  game: GameId;
}

export abstract class Resource {
  constructor(
    protected readonly http: HttpClient,
    protected readonly ctx: ClientContext,
  ) {}

  /**
   * Fetch one offset page from a Gacha-style list endpoint whose data is
   * `{ [key]: T[] }` beside a top-level `pagination`. Re-fetches through the
   * same builder for `next()`.
   */
  protected async offsetPage<T>(
    req: Omit<HttpRequest, "method"> & { method?: "GET" },
    key: string,
    params: OffsetPageParams | undefined,
  ): Promise<OffsetPage<T>> {
    const limit = params?.limit;
    const fetchAt = async (offset: number | undefined): Promise<OffsetPage<T>> => {
      const query: Query = { ...(req.query ?? {}), limit, offset };
      const res = await this.http.raw<Envelope<Record<string, unknown>>>({
        ...req,
        method: "GET",
        query,
      });
      const data = res.body.data ?? {};
      const items = (Array.isArray(data) ? data : (data[key] as T[] | undefined)) ?? [];
      const pagination: OffsetPagination = res.body.pagination ?? {
        limit: limit ?? items.length,
        offset: offset ?? 0,
        has_more: false,
      };
      return new OffsetPage<T>(items, pagination, fetchAt);
    };
    return fetchAt(params?.offset);
  }

  /**
   * Fetch one numbered page from a Card Data list endpoint — envelope
   * `{ success, data: T[], page, page_size, total_count, language }`.
   */
  protected async numberedPage<T>(
    req: Omit<HttpRequest, "method"> & { method?: "GET" },
    params: NumberedPageParams | undefined,
  ): Promise<NumberedPage<T>> {
    const pageSize = params?.page_size;
    const fetchAt = async (page: number | undefined): Promise<NumberedPage<T>> => {
      const query: Query = { ...(req.query ?? {}), page, page_size: pageSize };
      const body = await this.http.request<CatalogEnvelope<T[]>>({ ...req, method: "GET", query });
      return new NumberedPage<T>(
        body.data ?? [],
        {
          page: body.page ?? page ?? 1,
          page_size: body.page_size ?? pageSize ?? (body.data?.length ?? 0),
          total_count: body.total_count ?? body.data?.length ?? 0,
          language: body.language,
        },
        fetchAt,
      );
    };
    return fetchAt(params?.page);
  }

  /** Split `RequestOverrides` out of a params object so the rest can be sent as query/body. */
  protected split<P extends RequestOverrides>(
    params: P | undefined,
  ): { overrides: RequestOverrides; rest: Omit<P, keyof RequestOverrides> } {
    const { signal, timeoutMs, headers, maxRetries, ...rest } = (params ?? {}) as P;
    const overrides: RequestOverrides = {};
    if (signal) overrides.signal = signal;
    if (timeoutMs !== undefined) overrides.timeoutMs = timeoutMs;
    if (headers) overrides.headers = headers;
    if (maxRetries !== undefined) overrides.maxRetries = maxRetries;
    return { overrides, rest: rest as Omit<P, keyof RequestOverrides> };
  }
}
