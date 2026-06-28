export interface YearMonth {
  year: number;
  month: number;
}

export interface CalendarDay {
  iso: string;
  dayOfMonth: number;
  isInMonth: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_STARTS_ON_MONDAY = 1;
const GRID_ROWS = 6;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoFromYmd(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function visibleGridRange(yearMonth: YearMonth): { start: string; end: string } {
  const { start: startIso, end: endIso } = grid(yearMonth);
  const startDate = new Date(`${startIso}T00:00:00Z`);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + GRID_ROWS * 7 - 1);
  return {
    start: startIso,
    end: endIso,
  };
}

export function grid(yearMonth: YearMonth): { weeks: CalendarDay[][]; start: string; end: string } {
  const { year, month } = yearMonth;
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstDow = firstOfMonth.getUTCDay();
  const offsetToMonday = (firstDow - WEEK_STARTS_ON_MONDAY + 7) % 7;
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(1 - offsetToMonday);

  const weeks: CalendarDay[][] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const week: CalendarDay[] = [];
    for (let col = 0; col < 7; col += 1) {
      const day = new Date(gridStart);
      day.setUTCDate(gridStart.getUTCDate() + row * 7 + col);
      const iso = isoFromYmd(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      week.push({
        iso,
        dayOfMonth: day.getUTCDate(),
        isInMonth: day.getUTCMonth() === month && day.getUTCFullYear() === year,
      });
    }
    weeks.push(week);
  }

  const start = weeks[0]?.[0]?.iso ?? isoFromYmd(year, month, 1);
  const lastWeek = weeks[weeks.length - 1] ?? [];
  const end = lastWeek[lastWeek.length - 1]?.iso ?? isoFromYmd(year, month, 1);
  return { weeks, start, end };
}

export function currentYearMonth(): YearMonth {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
}

export function isCurrentYearMonth(yearMonth: YearMonth): boolean {
  const current = currentYearMonth();
  return yearMonth.year === current.year && yearMonth.month === current.month;
}

export function compareYearMonth(a: YearMonth, b: YearMonth): -1 | 0 | 1 {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  return 0;
}

export function firstOfMonthIso(yearMonth: YearMonth): string {
  return isoFromYmd(yearMonth.year, yearMonth.month, 1);
}

export function isWeekend(iso: string): boolean {
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3) return false;
  const [y, m, d] = parts as [number, number, number];
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function formatLongDate(iso: string): string {
  const parts = iso.split('-').map(Number);
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return iso;
  }
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function addDays(iso: string, days: number): string {
  if (!ISO_DATE.test(iso)) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

export interface ListWindow {
  start: string;
  end: string;
  label: string;
}

const SHORT_MONTH = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function listWindow(startIso: string, days: number): ListWindow {
  const endIso = addDays(startIso, days);
  const startParts = startIso.split('-').map(Number) as [number, number, number];
  const endParts = endIso.split('-').map(Number) as [number, number, number];
  const [, startMonth, startDay] = startParts;
  const [endYear, endMonth, endDay] = endParts;
  const startLabel = `${SHORT_MONTH[startMonth - 1]} ${startDay}`;
  const endLabel = `${SHORT_MONTH[endMonth - 1]} ${endDay}, ${endYear}`;
  return { start: startIso, end: endIso, label: `${startLabel} – ${endLabel}` };
}

export function addMonths(yearMonth: YearMonth, delta: number): YearMonth {
  const d = new Date(Date.UTC(yearMonth.year, yearMonth.month + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

export function formatYearMonth(yearMonth: YearMonth): string {
  const date = new Date(Date.UTC(yearMonth.year, yearMonth.month, 1));
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function dayCovers(day: string, startDate: string, endDate: string): boolean {
  if (!ISO_DATE.test(day) || !ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) return false;
  return day >= startDate && day <= endDate;
}

export function dayPartLabel(dp: 'morning' | 'evening' | 'all_day'): string {
  if (dp === 'morning') return 'AM';
  if (dp === 'evening') return 'PM';
  return 'Full';
}

export function ptoCoversDay(pto: { startDate: string; endDate: string }, day: string): boolean {
  return dayCovers(day, pto.startDate, pto.endDate);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase();
}
