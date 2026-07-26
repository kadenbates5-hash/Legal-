/**
 * Clock in / clock out, with daily, weekly and monthly totals.
 *
 * This is the *capture* side of `payroll.ts`: punches record when
 * someone was actually working, and a completed shift can be posted to
 * payroll, where a rate turns it into gross pay. Keeping them separate
 * matters — a punch is a fact about the clock, a payroll entry is a fact
 * about money, and correcting one shouldn't silently rewrite the other.
 *
 * Two things real timeclocks routinely get wrong, both handled here:
 *
 * **Day boundaries are local, not UTC.** Someone clocking in at 9pm in
 * New York is already "tomorrow" in UTC, so bucketing by UTC date puts
 * their hours in the wrong day — and therefore the wrong week and the
 * wrong pay period. Every aggregation here takes an IANA timezone and
 * derives the local calendar date through `Intl`, so a firm's day is
 * the firm's day.
 *
 * **People forget to clock out.** An open shift left running silently
 * accrues hours forever and produces an absurd paycheck. Open shifts
 * are never counted as complete, and one older than
 * `STALE_OPEN_SHIFT_HOURS` is reported as `likelyForgotten` so it gets
 * corrected rather than paid.
 *
 * Durations are always derived from the two timestamps, never stored, so
 * a corrected punch can't leave a stale total behind.
 */
/**
 * Why a punch was refused. Carried explicitly rather than left for a
 * caller to infer from the message text — an HTTP layer matching status
 * codes against error prose breaks the moment the wording improves.
 *
 * - `invalid` — the request itself is malformed (400)
 * - `not_found` — no such shift (404)
 * - `conflict` — the request is well-formed but disagrees with the
 *   clock's current state, e.g. clocking in twice (409)
 */
export type TimeClockErrorKind = "invalid" | "not_found" | "conflict";

export class TimeClockError extends Error {
  readonly kind: TimeClockErrorKind;

  constructor(message: string, kind: TimeClockErrorKind = "conflict") {
    super(message);
    this.name = "TimeClockError";
    this.kind = kind;
  }
}

/** An open shift older than this is almost certainly a missed clock-out, not a very long day. */
export const STALE_OPEN_SHIFT_HOURS = 16;

export interface Shift {
  readonly id: string;
  readonly actorId: string;
  clockInAt: string;
  /** Undefined while the shift is still open. */
  clockOutAt: string | undefined;
  note: string | undefined;
  /** Set when this shift has been posted to payroll, so it can't be double-counted. */
  postedPayrollEntryId: string | undefined;
  /** Non-empty when someone corrected the punch — kept so the original isn't silently lost. */
  corrections: { at: string; by: string; reason: string; previousClockInAt: string; previousClockOutAt: string | undefined }[];
}

export interface ShiftView extends Shift {
  /** Elapsed milliseconds. For an open shift, elapsed *so far*. */
  durationMs: number;
  open: boolean;
  likelyForgotten: boolean;
  /** Local calendar date (in the requested timezone) the shift started on. */
  localDate: string;
}

export type BucketKind = "day" | "week" | "month";

export interface TimeBucket {
  /** "2026-07-26" for a day, "2026-W31" for a week, "2026-07" for a month. */
  key: string;
  /** Local date the bucket starts on — useful for display and sorting. */
  startDate: string;
  totalMs: number;
  shiftCount: number;
}

export interface TimeClockSnapshot {
  shifts: Shift[];
  nextId: number;
}

/**
 * The local calendar date in a given IANA timezone. `en-CA` is used
 * because it formats as YYYY-MM-DD, which sorts correctly as a string.
 */
function localDateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new TimeClockError(`'${timeZone}' is not a recognised IANA timezone (e.g. 'America/New_York')`, "invalid");
  }
}

/** Monday-start ISO week. Returns the week key and the Monday's date. */
function isoWeekOf(localDate: string): { key: string; startDate: string } {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  // Work in UTC purely as calendar arithmetic — the date is already local.
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayOfWeek);

  // ISO week number: the Thursday of this week determines the year.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstMonday = new Date(firstThursday);
  firstMonday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7));
  const week = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;

  return {
    key: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    startDate: monday.toISOString().slice(0, 10),
  };
}

export class TimeClock {
  #shifts: Shift[] = [];
  #nextId = 1;
  #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Starts a shift. Refuses if one is already open — being clocked into
   * two shifts at once is never a real state, and allowing it makes
   * every total downstream wrong.
   */
  clockIn(actorId: string, note?: string): Shift {
    const id = actorId.trim();
    if (!id) throw new TimeClockError("actorId is required", "invalid");
    const open = this.openShift(id);
    if (open) {
      throw new TimeClockError(
        `already clocked in since ${open.clockInAt} — clock out first (or correct that shift if it was left open by mistake)`,
      );
    }
    const shift: Shift = {
      id: `shift_${this.#nextId++}`,
      actorId: id,
      clockInAt: this.#now().toISOString(),
      clockOutAt: undefined,
      note: note?.trim() || undefined,
      postedPayrollEntryId: undefined,
      corrections: [],
    };
    this.#shifts.push(shift);
    return shift;
  }

  clockOut(actorId: string, note?: string): Shift {
    const open = this.openShift(actorId.trim());
    if (!open) throw new TimeClockError("not currently clocked in", "conflict");
    open.clockOutAt = this.#now().toISOString();
    if (note?.trim()) open.note = open.note ? `${open.note}; ${note.trim()}` : note.trim();
    return open;
  }

  openShift(actorId: string): Shift | undefined {
    return this.#shifts.find((s) => s.actorId === actorId && !s.clockOutAt);
  }

  /**
   * Corrects a punch — for the forgotten clock-out, or a mistyped start.
   * The previous values are kept in `corrections` rather than
   * overwritten, so an adjusted timesheet still shows that it was
   * adjusted, by whom, and why.
   */
  adjust(
    shiftId: string,
    params: { clockInAt?: string; clockOutAt?: string; by: string; reason: string },
  ): Shift {
    const shift = this.#shifts.find((s) => s.id === shiftId);
    if (!shift) throw new TimeClockError(`no shift '${shiftId}'`, "not_found");
    if (!params.reason.trim()) throw new TimeClockError("correcting a punch needs a reason", "invalid");
    if (shift.postedPayrollEntryId) {
      throw new TimeClockError(
        `shift '${shiftId}' has already been posted to payroll — correct the payroll entry instead so the two can't disagree`,
      );
    }

    const nextIn = params.clockInAt ?? shift.clockInAt;
    const nextOut = params.clockOutAt ?? shift.clockOutAt;
    if (Number.isNaN(Date.parse(nextIn))) throw new TimeClockError("clockInAt is not a valid timestamp", "invalid");
    if (nextOut !== undefined && Number.isNaN(Date.parse(nextOut))) {
      throw new TimeClockError("clockOutAt is not a valid timestamp", "invalid");
    }
    if (nextOut !== undefined && Date.parse(nextOut) <= Date.parse(nextIn)) {
      throw new TimeClockError("a shift must end after it starts", "invalid");
    }

    shift.corrections.push({
      at: this.#now().toISOString(),
      by: params.by,
      reason: params.reason.trim(),
      previousClockInAt: shift.clockInAt,
      previousClockOutAt: shift.clockOutAt,
    });
    shift.clockInAt = nextIn;
    shift.clockOutAt = nextOut;
    return shift;
  }

  markPosted(shiftId: string, payrollEntryId: string): Shift {
    const shift = this.#shifts.find((s) => s.id === shiftId);
    if (!shift) throw new TimeClockError(`no shift '${shiftId}'`, "not_found");
    if (!shift.clockOutAt) throw new TimeClockError("an open shift can't be posted to payroll — clock out first", "conflict");
    if (shift.postedPayrollEntryId) throw new TimeClockError(`shift '${shiftId}' has already been posted to payroll`);
    shift.postedPayrollEntryId = payrollEntryId;
    return shift;
  }

  get(shiftId: string): Shift | undefined {
    return this.#shifts.find((s) => s.id === shiftId);
  }

  /**
   * Shifts for one person, optionally bounded by *local* dates. The
   * bound is applied to the shift's local start date, so "this week" in
   * the firm's timezone means what the firm means by it.
   */
  listShifts(actorId: string, timeZone: string, fromDate?: string, toDate?: string): ShiftView[] {
    assertValidTimeZone(timeZone);
    return this.#shifts
      .filter((s) => s.actorId === actorId)
      .map((s) => this.#view(s, timeZone))
      .filter((v) => (!fromDate || v.localDate >= fromDate) && (!toDate || v.localDate <= toDate))
      .sort((a, b) => a.clockInAt.localeCompare(b.clockInAt));
  }

  /**
   * Totals by day, week or month.
   *
   * Only **completed** shifts count. An open shift has no end, so
   * including it would report a total that changes every time you look
   * at it — and an open shift that was actually a missed clock-out would
   * inflate it without bound.
   *
   * A shift that runs past midnight is attributed to the day it
   * *started*, which is the common payroll convention and keeps a single
   * shift from being split across two pay periods.
   */
  totals(actorId: string, kind: BucketKind, timeZone: string, fromDate?: string, toDate?: string): TimeBucket[] {
    const buckets = new Map<string, TimeBucket>();
    for (const view of this.listShifts(actorId, timeZone, fromDate, toDate)) {
      if (view.open) continue;
      const { key, startDate } =
        kind === "day"
          ? { key: view.localDate, startDate: view.localDate }
          : kind === "week"
            ? isoWeekOf(view.localDate)
            : { key: view.localDate.slice(0, 7), startDate: `${view.localDate.slice(0, 7)}-01` };

      const bucket = buckets.get(key) ?? { key, startDate, totalMs: 0, shiftCount: 0 };
      bucket.totalMs += view.durationMs;
      bucket.shiftCount += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  /**
   * The current local calendar date, from *this clock's* notion of now.
   * Anything asking "which bucket is today's" has to go through here
   * rather than reaching for `new Date()` — two notions of now in one
   * calculation is how a total ends up in the wrong day.
   */
  today(timeZone: string): string {
    assertValidTimeZone(timeZone);
    return localDateIn(this.#now().toISOString(), timeZone);
  }

  /** Everyone currently on the clock — what a "who's working right now" view needs. */
  openShifts(timeZone: string): ShiftView[] {
    assertValidTimeZone(timeZone);
    return this.#shifts.filter((s) => !s.clockOutAt).map((s) => this.#view(s, timeZone));
  }

  #view(shift: Shift, timeZone: string): ShiftView {
    const start = Date.parse(shift.clockInAt);
    const end = shift.clockOutAt ? Date.parse(shift.clockOutAt) : this.#now().getTime();
    const durationMs = Math.max(0, end - start);
    return {
      ...shift,
      corrections: shift.corrections.map((c) => ({ ...c })),
      durationMs,
      open: !shift.clockOutAt,
      likelyForgotten: !shift.clockOutAt && durationMs > STALE_OPEN_SHIFT_HOURS * 60 * 60 * 1000,
      localDate: localDateIn(shift.clockInAt, timeZone),
    };
  }

  toSnapshot(): TimeClockSnapshot {
    return {
      shifts: this.#shifts.map((s) => ({ ...s, corrections: s.corrections.map((c) => ({ ...c })) })),
      nextId: this.#nextId,
    };
  }

  static fromSnapshot(snapshot: TimeClockSnapshot, options: { now?: () => Date } = {}): TimeClock {
    const clock = new TimeClock(options);
    clock.#shifts = (snapshot.shifts ?? []).map((s) => ({ ...s, corrections: (s.corrections ?? []).map((c) => ({ ...c })) }));
    clock.#nextId = snapshot.nextId ?? clock.#shifts.length + 1;
    return clock;
  }
}

/** Milliseconds to a human "7h 30m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Milliseconds to thousandths of an hour, the unit `payroll.ts` prices in. */
export function msToHoursMilli(ms: number): number {
  return Math.round((ms / 3_600_000) * 1000);
}
