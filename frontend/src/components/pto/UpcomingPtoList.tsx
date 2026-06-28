import { useMemo } from 'react';
import type { DayPart, PTOWithUser, User } from '../../types/api';
import { canModifyPto } from '../../lib/permissions';

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

function formatRange(p: PTOWithUser): string {
  if (p.startDate === p.endDate) return p.startDate;
  return `${p.startDate} → ${p.endDate}`;
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
        className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
      >
        No PTOs in the next 3 months.
      </div>
    );
  }

  return (
    <div data-testid="upcoming-list" className="space-y-4">
      {groups.map((group) => (
        <section
          key={`${group.year}-${group.month}`}
          aria-label={group.label}
          data-testid={`upcoming-group-${group.year}-${String(group.month).padStart(2, '0')}`}
          className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
        >
          <h3 className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {group.label}
          </h3>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
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
                    className="flex flex-1 items-center gap-3 text-left hover:underline"
                  >
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {pto.user.name}
                    </span>
                    <span className="text-slate-600 dark:text-slate-300">{formatRange(pto)}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                      {dayPartLabel(pto.dayPart)}
                    </span>
                  </button>
                  {canModify ? (
                    <div className="flex flex-shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit(pto)}
                        className="min-h-9 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(pto)}
                        className="min-h-9 rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/50"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
