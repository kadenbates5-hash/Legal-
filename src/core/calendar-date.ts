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

/**
 * Whether `timeZone` is an IANA zone this runtime knows ("America/New_York"
 * is, "EST5" and "New York" aren't — or may not be, depending on the build).
 */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day it is at `now` somewhere: year, month (0–11), day of month, weekday (0 = Sunday). */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Which day it is at `now` in `timeZone` — or, with no zone, on this
 * machine's clock.
 *
 * "Today" is a question about a place. A server in UTC is already on
 * tomorrow from 7pm in New York, and still on yesterday until 11am in
 * Sydney, so every check that compares a date with today — a court date
 * the receptionist hears, a deadline coming due, an invoice going overdue,
 * the day a file closed — has to ask it in the firm's zone, not the host's.
 */
export function calendarDayIn(now: Date, timeZone?: string): CalendarDay {
  if (!timeZone) {
    return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate(), weekday: now.getDay() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")) - 1,
    day: Number(part("day")),
    weekday: WEEKDAY_INDEX[part("weekday")] ?? 0,
  };
}

/** Today as YYYY-MM-DD in `timeZone` (UTC when none is given — what every caller of this did before). */
export function todayIn(timeZone: string | undefined, now: Date = new Date()): string {
  const { year, month, day } = calendarDayIn(now, timeZone ?? "UTC");
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The zone, trimmed, or a plain error naming where it came from — for checking configuration once, at boot. */
export function checkedTimeZone(value: unknown, source: string): string {
  const zone = typeof value === "string" ? value.trim() : value;
  if (!isTimeZone(zone)) {
    throw new Error(`${source} must be an IANA time zone such as America/New_York (got ${JSON.stringify(value)})`);
  }
  return zone;
}

/**
 * The day an instant fell on in `timeZone` (UTC when none is given) — the
 * date to print for "issued", "paid" or "closed". An instant that isn't
 * one keeps its first ten characters, as every caller of this showed
 * before.
 */
export function dayOf(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso.slice(0, 10) : todayIn(timeZone, new Date(ms));
}

/** `isoDate` plus `days` whole days (calendar arithmetic, no zone involved). */
export function addDaysToCalendarDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
