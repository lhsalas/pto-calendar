// Color palette for new-user auto-assignment. Distinct, accessible hues
// that work in both light and dark mode. Deduplicated against existing
// user colorCodes so two members don't share a chip on the calendar.
//
// Coverage: 16 hues from Tailwind 500-series. Each entry is a 6-digit
// lowercase hex with a leading `#` to match the existing colorCode format.

export const COLOR_PALETTE: ReadonlyArray<string> = [
  '#3B82F6', // blue-500
  '#10B981', // emerald-500
  '#F59E0B', // amber-500
  '#EF4444', // red-500
  '#8B5CF6', // violet-500
  '#EC4899', // pink-500
  '#14B8A6', // teal-500
  '#F97316', // orange-500
  '#84CC16', // lime-500
  '#06B6D4', // cyan-500
  '#6366F1', // indigo-500
  '#D946EF', // fuchsia-500
  '#0EA5E9', // sky-500
  '#22C55E', // green-500
  '#EAB308', // yellow-500
  '#A855F7', // purple-500
];

export function pickColorCode(used: ReadonlySet<string>): string {
  for (const color of COLOR_PALETTE) {
    if (!used.has(color)) return color;
  }
  // If the palette is exhausted, fall back to a deterministic hash-based
  // color so we still get something distinct.
  let hash = 0;
  for (let i = 0; i < 32; i++) {
    hash = (hash * 31 + i * 17) & 0xffffff;
  }
  const fallback = `#${hash.toString(16).padStart(6, '0').slice(-6)}`;
  return fallback;
}
