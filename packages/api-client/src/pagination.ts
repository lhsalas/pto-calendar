/**
 * The traversal over the opt-in paged calendar list.
 *
 * The engine is pure: it never touches the network itself, it only asks the
 * caller for the next page. It keeps the original filters fixed, deduplicates
 * by PTO id and reports an explicitly incomplete result whenever the traversal
 * stops early — a drifted page, an exhausted budget, a deadline, an abort or
 * an error. It never claims a consistent snapshot: rows can change between two
 * page requests, so only the records that were really read are returned.
 */

import {
  MAX_PAGE_LIMIT,
  PtoWireError,
  type ListAllQuery,
  type PtoPage,
  type PtoPageItem,
} from './wire.js';
import { PtoApiError } from './errors.js';

export type { ListAllQuery, ListQuery } from './wire.js';

/** The bounds of one traversal. */
export interface ListAllOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPages?: number;
  maxRecords?: number;
}

/** Why a traversal stopped. */
export type ListAllReason =
  'complete' | 'drift' | 'budget' | 'deadline' | 'aborted' | 'error' | 'invalid-response';

/** The typed cause of an incomplete traversal. */
export interface ListAllFailure {
  reason: Exclude<ListAllReason, 'complete'>;
  /** The original failure, when the service produced one. */
  error?: unknown;
}

/** The result of one traversal. */
export interface ListAllResult {
  items: PtoPageItem[];
  complete: boolean;
  reason: ListAllReason;
  pages: number;
  failure?: ListAllFailure;
}

/** What the engine needs to fetch the next page. */
export interface PageRequest {
  cursor: string | null;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** The caller-provided page loader. */
export type LoadPage = (request: PageRequest) => Promise<PtoPage>;

export const DEFAULT_MAX_PAGES = 30;
export const HARD_MAX_PAGES = 60;
export const DEFAULT_MAX_RECORDS = 5000;
export const HARD_MAX_RECORDS = 12000;
export const DEFAULT_TRAVERSAL_TIMEOUT_MS = 30_000;
export const HARD_MAX_TRAVERSAL_TIMEOUT_MS = 60_000;

function bound(value: number | undefined, fallback: number, hard: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), hard);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The documented order of a page: start date, owner, id. The separator is a
 * textual escape, never a raw control byte in the source.
 */
function orderKey(item: PtoPageItem): string {
  return `${item.startDate}\u0000${item.user.id.toLowerCase()}\u0000${item.id.toLowerCase()}`;
}

function pageIsOrdered(items: PtoPageItem[]): boolean {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!;
    const current = items[index]!;
    if (orderKey(previous) >= orderKey(current)) return false;
  }
  return true;
}

/**
 * Walks the paged list until it is complete or it stops for a reason the
 * caller has to know about.
 */
export async function traversePages(
  query: ListAllQuery,
  options: ListAllOptions,
  loadPage: LoadPage,
): Promise<ListAllResult> {
  const maxPages = bound(options.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
  const maxRecords = bound(options.maxRecords, DEFAULT_MAX_RECORDS, HARD_MAX_RECORDS);
  const timeoutMs = bound(
    options.timeoutMs,
    DEFAULT_TRAVERSAL_TIMEOUT_MS,
    HARD_MAX_TRAVERSAL_TIMEOUT_MS,
  );
  const deadline = performance.now() + timeoutMs;

  const items: PtoPageItem[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let pages = 0;
  let cursor: string | null = null;
  let lastKey: string | null = null;
  let finished = false;

  const stop = (reason: Exclude<ListAllReason, 'complete'>, error?: unknown): ListAllResult => ({
    items,
    complete: false,
    reason,
    pages,
    failure: { reason, ...(error === undefined ? {} : { error }) },
  });

  for (;;) {
    if (isAborted(options.signal)) {
      return stop('aborted');
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return stop('deadline');
    }
    if (finished) {
      // The completion is reported only after the cancellation and the
      // deadline have been checked once more.
      return { items, complete: true, reason: 'complete', pages };
    }
    if (pages >= maxPages) {
      // The caller's own bound was reached; there is no service failure.
      return stop('budget');
    }
    if (items.length >= maxRecords) {
      return stop('budget');
    }

    let page: PtoPage;
    try {
      page = await loadPage({
        cursor,
        ...(options.signal ? { signal: options.signal } : {}),
        // The remaining budget shrinks with every request; it is never reset.
        timeoutMs: Math.ceil(remaining),
      });
    } catch (error) {
      if (isAborted(options.signal)) {
        return stop('aborted', error);
      }
      if (
        error instanceof PtoWireError ||
        (error instanceof PtoApiError && error.code === 'INVALID_RESPONSE')
      ) {
        return stop('invalid-response', error);
      }
      if (performance.now() >= deadline) {
        return stop('deadline', error);
      }
      return stop('error', error);
    }

    pages += 1;

    if (!pageIsOrdered(page.items)) {
      return stop('drift');
    }
    if (page.hasMore !== (page.nextCursor !== null)) {
      return stop('drift');
    }
    if (page.items.length > MAX_PAGE_LIMIT) {
      return stop('drift');
    }
    if (query.limit !== undefined && page.items.length > query.limit) {
      return stop('drift');
    }
    if (page.hasMore && page.items.length === 0) {
      // A continued page that carries no record is inconsistent.
      return stop('drift');
    }

    const fresh: PtoPageItem[] = [];
    let duplicated = false;
    for (const item of page.items) {
      const id = item.id.toLowerCase();
      if (seen.has(id)) {
        duplicated = true;
        break;
      }
      seen.add(id);
      fresh.push(item);
    }
    if (duplicated) {
      return stop('drift');
    }
    if (lastKey !== null && fresh.length > 0 && orderKey(fresh[0]!) <= lastKey) {
      // The pages are not a continuation of each other.
      return stop('drift');
    }
    if (items.length + fresh.length > maxRecords) {
      items.push(...fresh.slice(0, maxRecords - items.length));
      return stop('budget');
    }
    items.push(...fresh);
    if (fresh.length > 0) {
      lastKey = orderKey(fresh[fresh.length - 1]!);
    }

    finished = !page.hasMore;
    if (finished) {
      continue;
    }
    const next = page.nextCursor!;
    if (cursors.has(next)) {
      return stop('drift');
    }
    cursors.add(next);
    cursor = next;
  }
}
