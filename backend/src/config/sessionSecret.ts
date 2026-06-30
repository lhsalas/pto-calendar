export const KNOWN_SESSION_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'replace-me-with-a-long-random-string-min-32-chars',
  'replace-me-with-a-long-random-string',
  'replace-me',
  'changeme',
  'change-me',
  'change-me-please',
]);

export const MIN_SESSION_SECRET_ENTROPY = 3.5;
export const MIN_SESSION_SECRET_LENGTH = 32;

const PLACEHOLDER_PREFIXES = ['replace-me', 'change-me', 'changeme'] as const;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function isPlaceholderSessionSecret(s: string): boolean {
  if (KNOWN_SESSION_SECRET_PLACEHOLDERS.has(s)) return true;
  const lower = s.toLowerCase();
  return PLACEHOLDER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isStrongSessionSecret(s: string): boolean {
  return (
    s.length >= MIN_SESSION_SECRET_LENGTH &&
    !isPlaceholderSessionSecret(s) &&
    shannonEntropy(s) >= MIN_SESSION_SECRET_ENTROPY
  );
}

export function parseSessionKeys(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
