import { dayPartLabel, initials, readableTextOn } from '../../lib/calendar';
import type { PTOWithUser } from '../../types/api';

export interface PTOChipProps {
  pto: PTOWithUser;
  onClick?: (pto: PTOWithUser) => void;
}

export function PTOChip({ pto, onClick }: PTOChipProps): JSX.Element {
  const isMultiDay = pto.startDate !== pto.endDate;
  const label = isMultiDay ? 'Full' : dayPartLabel(pto.dayPart);
  const userInitials = initials(pto.user.name);
  const textColor = readableTextOn(pto.user.colorCode);

  return (
    <button
      type="button"
      onClick={() => onClick?.(pto)}
      title={`${pto.user.name} — ${label}`}
      className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-xs shadow-sm transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface dark:focus-visible:ring-offset-surface-dark"
      style={{ backgroundColor: pto.user.colorCode, color: textColor }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white/30 text-[10px] font-semibold"
      >
        {userInitials}
      </span>
      <span className="truncate">{pto.user.name}</span>
      {!isMultiDay ? (
        <span className="ml-auto flex-shrink-0 rounded bg-white/30 px-1 text-[10px] font-medium">
          {label}
        </span>
      ) : null}
    </button>
  );
}
