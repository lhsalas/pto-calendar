import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RECORDS,
  DEFAULT_TRAVERSAL_TIMEOUT_MS,
  HARD_MAX_PAGES,
  HARD_MAX_RECORDS,
  HARD_MAX_TRAVERSAL_TIMEOUT_MS,
  traversePages,
  type ListAllQuery,
  type LoadPage,
} from '../src/pagination.js';
import { PtoWireError, type PtoPage, type PtoPageItem } from '../src/wire.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const QUERY: ListAllQuery = { start: '2026-05-01', end: '2026-05-31' };

function item(index: number): PtoPageItem {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    user: { id: OWNER, name: 'Owner', colorCode: '#123456' },
    startDate: '2026-05-10',
    endDate: '2026-05-10',
    dayPart: 'morning',
    note: null,
    version: 1,
  };
}

function page(items: PtoPageItem[], cursor: string | null, hasMore = cursor !== null): PtoPage {
  return { items, nextCursor: cursor, hasMore };
}

/** A loader that serves `count` pages of `size` items each. */
function pages(count: number, size: number): LoadPage {
  let served = 0;
  return async () => {
    const items = Array.from({ length: size }, (_, index) => item(served * size + index + 1));
    served += 1;
    return served >= count ? page(items, null, false) : page(items, `cursor-${served}`, true);
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('traversePages', () => {
  it('walks every page and reports a complete result', async () => {
    const result = await traversePages(QUERY, {}, pages(2, 3));
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('complete');
    expect(result.pages).toBe(2);
    expect(result.items).toHaveLength(6);
    expect(result.failure).toBeUndefined();
  });

  it('traverses more than a thousand records with the paged envelope', async () => {
    const result = await traversePages(QUERY, {}, pages(6, 200));
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(1200);
    expect(result.pages).toBe(6);
    expect(new Set(result.items.map((entry) => entry.id)).size).toBe(1200);
  });

  it('keeps the original filters and starts without a cursor', async () => {
    const seen: Array<string | null> = [];
    const loader: LoadPage = async (request) => {
      seen.push(request.cursor);
      return page([item(1)], null, false);
    };
    const result = await traversePages({ ...QUERY, userId: OWNER, limit: 50 }, {}, loader);
    expect(result.complete).toBe(true);
    expect(seen).toEqual([null]);
  });

  it('stops on an unordered page and keeps what it really read', async () => {
    const loader: LoadPage = async () => page([item(2), item(1)], 'cursor-1', true);
    const result = await traversePages(QUERY, {}, loader);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('drift');
    expect(result.items).toHaveLength(0);
    expect(result.failure?.reason).toBe('drift');
  });

  it('stops when the page end and the cursor disagree', async () => {
    const withoutCursor: LoadPage = async () => page([item(1)], null, true);
    expect((await traversePages(QUERY, {}, withoutCursor)).reason).toBe('drift');
    const withCursor: LoadPage = async () => page([item(1)], 'cursor-1', false);
    expect((await traversePages(QUERY, {}, withCursor)).reason).toBe('drift');
  });

  it('stops on a repeated record or a repeated cursor', async () => {
    const repeatedRecord: LoadPage = async () => page([item(1), item(1)], 'cursor-1', true);
    const record = await traversePages(QUERY, {}, repeatedRecord);
    expect(record.reason).toBe('drift');
    expect(record.items).toHaveLength(0);

    // The same record again in a later page is a drift too, even though every
    // page is ordered on its own.
    let served = 0;
    const acrossPages: LoadPage = async () => {
      served += 1;
      return served === 1 ? page([item(1)], 'cursor-1', true) : page([item(1)], null, false);
    };
    const across = await traversePages(QUERY, {}, acrossPages);
    expect(across.reason).toBe('drift');
    expect(across.items).toHaveLength(1);

    const lower = { ...item(1), id: 'abcd0000-0000-4000-8000-000000000001' };
    const differentCase: LoadPage = async (request) =>
      request.cursor === null
        ? page([lower], 'cursor-1', true)
        : page([{ ...lower, id: lower.id.toUpperCase() }], null, false);
    const caseDuplicate = await traversePages(QUERY, {}, differentCase);
    expect(caseDuplicate.reason).toBe('drift');
    expect(caseDuplicate.items).toEqual([lower]);

    const repeatedCursor: LoadPage = async (request) =>
      page([item(request.cursor === null ? 1 : 2)], 'cursor-1', true);
    const cursor = await traversePages(QUERY, {}, repeatedCursor);
    expect(cursor.reason).toBe('drift');
  });

  it('stops when the page or record budget is exhausted', async () => {
    const pagesLimited = await traversePages(QUERY, { maxPages: 2 }, pages(5, 3));
    expect(pagesLimited.reason).toBe('budget');
    expect(pagesLimited.pages).toBe(2);
    expect(pagesLimited.items).toHaveLength(6);

    const recordsLimited = await traversePages(QUERY, { maxRecords: 10 }, pages(5, 3));
    expect(recordsLimited.reason).toBe('budget');
    expect(recordsLimited.items).toHaveLength(10);
  });

  it('bounds the page, record and time budgets', async () => {
    expect(DEFAULT_MAX_PAGES).toBe(30);
    expect(HARD_MAX_PAGES).toBe(60);
    expect(DEFAULT_MAX_RECORDS).toBe(5000);
    expect(HARD_MAX_RECORDS).toBe(12000);
    expect(DEFAULT_TRAVERSAL_TIMEOUT_MS).toBe(30_000);
    expect(HARD_MAX_TRAVERSAL_TIMEOUT_MS).toBe(60_000);

    const limited = await traversePages(QUERY, { maxPages: 999, maxRecords: 99999 }, pages(1, 1));
    expect(limited.complete).toBe(true);

    // A bound of zero still allows one page and one record.
    const noPages = await traversePages(QUERY, { maxPages: 0 }, pages(3, 1));
    expect(noPages.reason).toBe('budget');
    expect(noPages.pages).toBe(1);
    const fractional = await traversePages(QUERY, { maxPages: 0.5 }, pages(3, 1));
    expect(fractional.pages).toBe(1);

    const noRecords = await traversePages(QUERY, { maxRecords: 0 }, pages(3, 1));
    expect(noRecords.reason).toBe('budget');
    expect(noRecords.items).toHaveLength(1);

    // A bound that is not a number falls back to the default.
    const unbounded = await traversePages(
      QUERY,
      { maxPages: Number.NaN, maxRecords: Number.POSITIVE_INFINITY, timeoutMs: Number.NaN },
      pages(2, 1),
    );
    expect(unbounded.complete).toBe(true);
  });

  it('stops at the deadline, which spans the requests', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    const loader: LoadPage = async () => {
      // A wall-clock correction cannot extend the total request budget.
      vi.setSystemTime(Date.now() - 30_000);
      vi.advanceTimersByTime(500);
      return page([item(1)], null, false);
    };
    const result = await traversePages(QUERY, { timeoutMs: 100 }, loader);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('deadline');
    expect(result.failure?.reason).toBe('deadline');

    // A request that fails after the deadline is a deadline, not a plain error.
    const failing: LoadPage = async () => {
      vi.advanceTimersByTime(500);
      throw new Error('too late');
    };
    const failed = await traversePages(QUERY, { timeoutMs: 100 }, failing);
    expect(failed.reason).toBe('deadline');
    expect(failed.failure?.reason).toBe('deadline');
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await traversePages(QUERY, { signal: controller.signal }, pages(1, 1));
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('aborted');
    expect(result.failure?.reason).toBe('aborted');

    const aborting: LoadPage = async () => {
      controller.abort();
      return page([item(1)], null, false);
    };
    const second = new AbortController();
    const throwing: LoadPage = async () => {
      second.abort();
      throw new Error('cancelled');
    };
    const thrown = await traversePages(QUERY, { signal: second.signal }, throwing);
    expect(thrown.reason).toBe('aborted');
    const aborted = await traversePages(QUERY, { signal: controller.signal }, aborting);
    expect(aborted.reason).toBe('aborted');
  });

  it('stops before the next request when the record budget is spent', async () => {
    const spent = await traversePages(QUERY, { maxRecords: 2 }, pages(2, 2));
    expect(spent.reason).toBe('budget');
    expect(spent.pages).toBe(1);
    expect(spent.items).toHaveLength(2);
  });

  it('stops when a later page is not a continuation of the first', async () => {
    const loader: LoadPage = async (request) =>
      request.cursor === null ? page([item(2)], 'cursor-1', true) : page([item(1)], null, false);
    const result = await traversePages(QUERY, {}, loader);
    expect(result.reason).toBe('drift');
    expect(result.items).toHaveLength(1);
  });

  it('stops when a continued page carries no record', async () => {
    const loader: LoadPage = async () => page([], 'cursor-1', true);
    const result = await traversePages(QUERY, {}, loader);
    expect(result.reason).toBe('drift');
    expect(result.items).toHaveLength(0);
  });

  it('stops when a page carries more records than the caller asked for', async () => {
    const tooMany: LoadPage = async () => page([item(1), item(2)], null, false);
    const result = await traversePages({ ...QUERY, limit: 1 }, {}, tooMany);
    expect(result.reason).toBe('drift');

    const overTheCap: LoadPage = async () =>
      page(
        Array.from({ length: 201 }, (_, index) => item(index + 1)),
        null,
        false,
      );
    const capped = await traversePages(QUERY, {}, overTheCap);
    expect(capped.reason).toBe('drift');
  });

  it('gives every request a shrinking bound of at least a millisecond', async () => {
    const bounds: number[] = [];
    const loader: LoadPage = async (request) => {
      bounds.push(request.timeoutMs);
      return page([item(1)], 'cursor-1', true);
    };
    await traversePages(QUERY, { timeoutMs: 5_000 }, loader);
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) {
      expect(bound).toBeGreaterThanOrEqual(1);
    }
    expect(bounds[0]).toBeGreaterThanOrEqual(bounds[bounds.length - 1]!);
  });

  it('does not report a completion after the caller aborted', async () => {
    const controller = new AbortController();
    const loader: LoadPage = async () => {
      controller.abort();
      return page([item(1)], null, false);
    };
    const result = await traversePages(QUERY, { signal: controller.signal }, loader);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('aborted');
  });

  it('keeps the original failure of the service', async () => {
    const failure = Object.assign(new Error('boom'), {
      code: 'STALE_WRITE',
      status: 412,
      requestId: 'req-1',
    });
    const loader: LoadPage = async () => {
      throw failure;
    };
    const result = await traversePages(QUERY, {}, loader);
    expect(result.failure?.error).toBe(failure);
  });

  it('reports an upstream failure with its machine cause', async () => {
    const failure = Object.assign(new Error('boom'), {
      code: 'STALE_WRITE',
      status: 412,
      requestId: 'req-1',
    });
    const loader: LoadPage = async () => {
      throw failure;
    };
    const result = await traversePages(QUERY, {}, loader);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.failure?.reason).toBe('error');
    expect(result.failure?.error).toBe(failure);
    expect((result.failure?.error as { code: string }).code).toBe('STALE_WRITE');

    // A failure without a status or a correlation id still has a cause.
    const bare = await traversePages(QUERY, {}, async () => {
      throw new Error('boom');
    });
    expect(bare.failure?.reason).toBe('error');
    expect(bare.failure?.error).toBeInstanceOf(Error);
  });

  it('reports a malformed page as an invalid response', async () => {
    const loader: LoadPage = async () => {
      throw new PtoWireError();
    };
    const result = await traversePages(QUERY, {}, loader);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('invalid-response');
    expect(result.failure?.reason).toBe('invalid-response');
  });
});
