import { useMemo } from 'react';
import { motion } from 'motion/react';
import type { DayPart, PTOWithUser, User } from '../../types/api';
import { canModifyPto } from '../../lib/permissions';
import { formatRangeLabel } from '../../lib/calendar';

export interface UpcomingPtoListProps {
  ptoList: PTOWithUser[];
  currentUser: User;
  onRowClick: (pto: PTOWithUser) => void;
  onEdit: (pto: PTOWithUser) => void;
  onDelete: (pto: PTOWithUser) => Promise<void>;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function dayPartLabel(dp: DayPart): string {
  if (dp === 'morning') return 'AM';
  if (dp === 'evening') return 'PM';
  return 'Full';
}

interface MonthGroup {
  year: number;
  month: number;
  label: string;
  items: PTOWithUser[];
}

function groupByMonth(ptoList: PTOWithUser[]): MonthGroup[] {
  const sorted = [...ptoList].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const groups = new Map<string, MonthGroup>();
  for (const pto of sorted) {
    const [y, m] = pto.startDate.split('-').map(Number) as [number, number];
    const key = `${y}-${m}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        year: y,
        month: m,
        label: `${MONTHS[m - 1]} ${y}`,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(pto);
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
}

export function UpcomingPtoList({
  ptoList,
  currentUser,
  onRowClick,
  onEdit,
  onDelete,
}: UpcomingPtoListProps): JSX.Element {
  const groups = useMemo(() => groupByMonth(ptoList), [ptoList]);

  if (ptoList.length === 0) {
    return (
      <div
        data-testid="upcoming-empty"
        className="rounded-lg border border-border bg-surface-3 p-6 text-center text-sm text-ink-muted dark:border-border-dark dark:bg-surface-dark-3 dark:text-ink-muted-dark"
      >
        No PTOs in the next 3 months.
      </div>
    );
  }

  return (
    <div data-testid="upcoming-list" className="space-y-4">
      {groups.map((group) => (
        <motion.section
          key={`${group.year}-${group.month}`}
          aria-label={group.label}
          data-testid={`upcoming-group-${group.year}-${String(group.month).padStart(2, '0')}`}
          whileHover={{ y: -1 }}
          transition={{ type: 'tween', duration: 0.12, ease: 'easeOut' }}
          className="rounded-lg border border-border bg-surface-3 shadow-sm dark:border-border-dark dark:bg-surface-dark-3"
        >
          <h3 className="border-b border-border bg-surface-2 px-3 py-1.5 font-display text-sm font-semibold tracking-tight text-ink dark:border-border-dark dark:bg-surface-dark-2 dark:text-ink-dark">
            {group.label}
          </h3>
          <ul className="divide-y divide-border dark:divide-border-dark">
            {group.items.map((pto) => {
              const canModify = canModifyPto(
                { id: currentUser.id, role: currentUser.role },
                { userId: pto.user.id },
              );
              return (
                <li
                  key={pto.id}
                  data-testid={`upcoming-row-${pto.id}`}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 flex-shrink-0 rounded"
                    style={{ backgroundColor: pto.user.colorCode }}
                  />
                  <button
                    type="button"
                    onClick={() => onRowClick(pto)}
                    className="flex flex-1 items-center gap-3 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
                  >
                    <span className="font-medium text-ink dark:text-ink-dark">{pto.user.name}</span>
                    <span className="font-mono text-xs tabular-nums text-ink-muted dark:text-ink-muted-dark">
                      {formatRangeLabel(pto.startDate, pto.endDate)}
                    </span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted dark:bg-surface-dark-2 dark:text-ink-muted-dark">
                      {dayPartLabel(pto.dayPart)}
                    </span>
                  </button>
                  {canModify ? (
                    <div className="flex flex-shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit(pto)}
                        className="min-h-9 rounded border border-border px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:border-border-dark dark:text-ink-dark dark:hover:bg-surface-dark-2 dark:focus-visible:ring-offset-surface-dark"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(pto)}
                        className="min-h-9 rounded border border-danger/30 px-3 py-1.5 text-sm text-danger transition-colors duration-150 hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </motion.section>
      ))}
    </div>
  );
}
