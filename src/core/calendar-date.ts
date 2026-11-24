/**
 * A real calendar day written YYYY-MM-DD — "2024-02-29" is, "2026-02-30",
 * "2026-7-28", "nope" and "someday" aren't. One check shared by every
 * store that keeps a day the user typed (billable hours, invoice lines,
 * matter key dates, the staff schedule), so they can't disagree about
 * what a date is. Years outside 1900–2200 are refused as typos.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
