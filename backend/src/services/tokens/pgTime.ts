/**
 * Prisma's PostgreSQL DateTime columns in this schema are timestamp without
 * time zone, with UTC wall-clock values. Never pass Date objects to pg for
 * these columns: pg formats Date parameters using the process timezone.
 */
export function timestampParameter(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
