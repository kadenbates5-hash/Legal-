/**
 * A moment in time as text that says which moment it is: a date, a
 * time, and the zone it was written in — `2026-11-26T10:00:00Z` or
 * `2026-11-26T10:00:00-05:00`.
 *
 * The zone is the part that matters. JavaScript reads
 * `2026-11-26T10:00:00` (no zone) in whatever zone the *server* runs in,
 * so the same text books 10am on a laptop in New York and 5am on a host
 * in UTC — and "July 26 2026 9:00 AM", which `Date` also accepts, does
 * the same. Every place a person or a model hands Docket a time that
 * becomes a record (a punch correction, an appointment) goes through
 * here, so none of them can be read in the wrong zone.
 */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** The instant `value` names, or undefined if it isn't a date and time with its zone. */
export function parseZonedInstant(value: unknown): Date | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!ZONED_INSTANT.test(text)) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/** The usual way to say what was wrong, so every refusal reads the same. */
export function zonedInstantProblem(label: string, value: unknown): string {
  return `${label} must be a date and time with its zone, like 2026-11-26T10:00:00-05:00 (got ${JSON.stringify(value ?? null)}) — without one it would be read in the server's zone`;
}

/** `GMT-05:00`-style offset of `timeZone` at `at`, or undefined if the zone isn't one Intl knows. */
export function utcOffsetLabel(timeZone: string, at: Date): string | undefined {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    if (!part) return undefined;
    // "GMT" alone is UTC itself.
    return part.value === "GMT" ? "+00:00" : part.value.replace(/^GMT/, "");
  } catch {
    return undefined;
  }
}
