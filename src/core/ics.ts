/**
 * A small iCalendar (RFC 5545) writer for the calendar-file export.
 *
 * Hand-rolled, same call as `csv.ts`: the format is small, and the parts
 * a naive string join gets wrong are knowable —
 *
 * - **Text escaping.** A comma, semicolon or backslash in a value means
 *   something to a parser; an unescaped newline ends the property. A
 *   matter id or a name with a comma in it would otherwise split an event
 *   title in two, or start a property nobody wrote.
 * - **Line folding.** Lines are capped at 75 *octets*, not characters,
 *   and continued with CRLF plus a space. Folding by characters splits a
 *   multi-byte character ("Muñoz") across two lines, which some calendar
 *   apps then show as garbage.
 * - **CRLF** line endings throughout, which the spec requires and Outlook
 *   in particular enforces.
 *
 * Pure: no store, no access control, no clock unless given one.
 */

export type IcsMoment =
  /** An all-day event on an ISO date (YYYY-MM-DD). */
  | { date: string }
  /** A timed event at an ISO timestamp, written in UTC. */
  | { dateTime: string };

export interface IcsEvent {
  /** Stable across exports, so re-importing updates an event rather than duplicating it. */
  uid: string;
  summary: string;
  description?: string;
  start: IcsMoment;
  /** Exclusive end. Defaults to the next day for an all-day event, the start for a timed one. */
  end?: IcsMoment;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  /** True for an event that shouldn't block time in a free/busy view (a deadline, say). */
  transparent?: boolean;
  /** A reminder, as an RFC 5545 duration before the start — e.g. "P1D", "PT1H". */
  alarmBefore?: string;
  categories?: string[];
}

export interface IcsCalendar {
  /** Identifies the product that wrote the file. */
  prodId: string;
  /** Shown as the calendar's name by apps that honour X-WR-CALNAME. */
  name?: string;
  events: IcsEvent[];
  /** When the file was written; every event's DTSTAMP. */
  now?: Date;
}

/** Escapes a TEXT value: backslash, semicolon, comma and newline, with other control characters dropped. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    // Control characters (other than the newline handled below) have no
    // business in a calendar value and some parsers choke on them.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Folds one content line to at most 75 octets per line, never splitting a UTF-8 character. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first line holds 75 octets; each continuation line starts with a
  // space, which counts, leaving 74 for content.
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74;
    }
    current += ch;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-11-23T20:40:00.000Z` → `20261123T204000Z`. */
export function formatIcsDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a timestamp: '${iso}'`);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** `2026-11-23` → `20261123`. */
export function formatIcsDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`not a date: '${isoDate}'`);
  return isoDate.replace(/-/g, "");
}

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function moment(name: "DTSTART" | "DTEND", m: IcsMoment): string {
  return "date" in m ? `${name};VALUE=DATE:${formatIcsDate(m.date)}` : `${name}:${formatIcsDateTime(m.dateTime)}`;
}

/** An RFC 5545 duration with no sign: "P1D", "PT1H", "P1DT12H", "P2W". */
const DURATION_RE = /^P(?:\d+W|\d+D|(?:\d+D)?T(?:\d+H)?(?:\d+M)?(?:\d+S)?)$/;
function isDuration(value: string): boolean {
  // The regex allows a bare "T" with nothing after it; the spec doesn't.
  return DURATION_RE.test(value) && !value.endsWith("T");
}

/** The whole file, CRLF-terminated, ready to serve as `text/calendar`. */
export function buildIcsCalendar(calendar: IcsCalendar): string {
  const stamp = formatIcsDateTime((calendar.now ?? new Date()).toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(calendar.prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (calendar.name) lines.push(`X-WR-CALNAME:${escapeIcsText(calendar.name)}`);

  for (const event of calendar.events) {
    const end: IcsMoment =
      event.end ?? ("date" in event.start ? { date: nextDay(event.start.date) } : { dateTime: event.start.dateTime });
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      moment("DTSTART", event.start),
      moment("DTEND", end),
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.categories?.length) lines.push(`CATEGORIES:${event.categories.map(escapeIcsText).join(",")}`);
    if (event.status) lines.push(`STATUS:${event.status}`);
    lines.push(`TRANSP:${event.transparent ? "TRANSPARENT" : "OPAQUE"}`);
    if (event.alarmBefore && event.status !== "CANCELLED") {
      if (!isDuration(event.alarmBefore)) throw new Error(`not a duration: '${event.alarmBefore}'`);
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(event.summary)}`,
        `TRIGGER:-${event.alarmBefore}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
