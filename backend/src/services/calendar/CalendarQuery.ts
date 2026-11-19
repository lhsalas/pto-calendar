import type { DayPart, PTORequest, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { DEFAULT_CALENDAR_PAGE_SIZE, MAX_CALENDAR_RESULTS } from './range.js';
import { mintCursor, type CalendarCursor } from './cursor.js';

export interface PTOWithUser {
  id: string;
  user: { id: string; name: string; colorCode: string };
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  /**
   * Always `null` in list responses. The column is not even selected for
   * lists, so a note cannot reach a list caller through this service.
   */
  note: null;
}

/**
 * The paged representation carries the revision of every entry, so a client
 * can name the version it read when it writes the entry back. The legacy
 * array representation keeps its historical shape and has no version.
 */
export interface PTOWithUserVersion extends PTOWithUser {
  version: number;
}

/** The validated filters a calendar query is executed with. */
export interface CalendarRangeFilters {
  start: string;
  end: string;
  /** Owner filter, applied in the database before sorting and limiting. */
  userId: string | null;
}

/** One page of the opt-in paged representation. */
export interface CalendarPage {
  items: PTOWithUserVersion[];
  nextCursor: string | null;
  hasMore: boolean;
}

const PTO_LIST_SELECT = {
  id: true,
  userId: true,
  startDate: true,
  endDate: true,
  dayPart: true,
  user: { select: { id: true, name: true, colorCode: true } },
} as const;

/** The paged representation also selects the revision of every entry. */
const PTO_PAGE_SELECT = {
  ...PTO_LIST_SELECT,
  version: true,
} as const;

/**
 * Deterministic total order: `(startDate, userId, id)`. The primary key is
 * the final tie-breaker, so two rows that share a start date and an owner
 * still have one stable order.
 */
const PTO_LIST_ORDER: Prisma.PTORequestOrderByWithRelationInput[] = [
  { startDate: 'asc' },
  { userId: 'asc' },
  { id: 'asc' },
];

function toDateOnly(dateStr: string): Date {
  const parts = dateStr.split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The overlap predicate plus the optional owner filter. The owner filter is
 * part of the database query, so an unrelated owner can never consume the
 * result budget of a filtered query.
 */
function buildWhere(
  filters: CalendarRangeFilters,
  cursor: CalendarCursor | null,
): Prisma.PTORequestWhereInput {
  const and: Prisma.PTORequestWhereInput[] = [
    { startDate: { lte: toDateOnly(filters.end) } },
    { endDate: { gte: toDateOnly(filters.start) } },
  ];
  if (filters.userId) and.push({ userId: filters.userId });
  if (cursor) {
    // Keyset continuation: strictly after the anchor in the same total order.
    // The anchor start date may be before the requested range start (an
    // overlapping row can start earlier), so it is only used as a sort key.
    const anchorDate = toDateOnly(cursor.anchor.startDate);
    and.push({
      OR: [
        { startDate: { gt: anchorDate } },
        { startDate: anchorDate, userId: { gt: cursor.anchor.userId } },
        {
          startDate: anchorDate,
          userId: cursor.anchor.userId,
          id: { gt: cursor.anchor.id },
        },
      ],
    });
  }
  return { AND: and };
}

function toPublicRow(row: {
  id: string;
  startDate: Date;
  endDate: Date;
  dayPart: DayPart;
  user: { id: string; name: string; colorCode: string };
}): PTOWithUser {
  return {
    id: row.id,
    user: { id: row.user.id, name: row.user.name, colorCode: row.user.colorCode },
    startDate: fromDateOnly(row.startDate),
    endDate: fromDateOnly(row.endDate),
    dayPart: row.dayPart,
    note: null,
  };
}

/** The paged projection adds the revision of the entry to the legacy fields. */
function toPublicVersionRow(row: {
  id: string;
  startDate: Date;
  endDate: Date;
  dayPart: DayPart;
  version: number;
  user: { id: string; name: string; colorCode: string };
}): PTOWithUserVersion {
  return { ...toPublicRow(row), version: row.version };
}

/**
 * The legacy array representation. It keeps the historical 1,000-row cap and
 * the historical response shape; only the optional owner filter is new, and it
 * is applied in the database before the cap.
 */
export async function listVisibleRange(filters: CalendarRangeFilters): Promise<PTOWithUser[]> {
  const rows = await prisma.pTORequest.findMany({
    where: buildWhere(filters, null),
    orderBy: PTO_LIST_ORDER,
    take: MAX_CALENDAR_RESULTS,
    select: PTO_LIST_SELECT,
  });
  return rows.map(toPublicRow);
}

/**
 * The opt-in paged representation. The page size is bounded, the continuation
 * is a keyset over `(startDate, userId, id)`, and `hasMore`/`nextCursor` make
 * truncation explicit instead of silent.
 */
export async function listVisiblePage(
  filters: CalendarRangeFilters,
  options: { limit?: number; cursor: CalendarCursor | null },
): Promise<CalendarPage> {
  const limit = options.limit ?? DEFAULT_CALENDAR_PAGE_SIZE;
  const rows = await prisma.pTORequest.findMany({
    where: buildWhere(filters, options.cursor),
    orderBy: PTO_LIST_ORDER,
    // One extra row answers "is there more?" without a second query.
    take: limit + 1,
    select: PTO_PAGE_SELECT,
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toPublicVersionRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? mintCursor(filters, {
          startDate: last.startDate,
          userId: last.user.id,
          id: last.id,
        })
      : null;
  return { items, nextCursor, hasMore };
}

export type { PTORequest };
