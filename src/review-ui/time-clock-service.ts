import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditLog } from "../core/audit.js";
import type { PayrollStore, WorkedHoursEntry } from "../core/payroll.js";
import {
  TimeClockError,
  msToHoursMilli,
  type BucketKind,
  type Shift,
  type ShiftView,
  type TimeBucket,
  type TimeClock,
} from "../core/time-clock.js";

/**
 * Backs the "Time Clock" panel.
 *
 * Access follows the same shape as payroll, because a timesheet is
 * effectively pay data: **punch your own clock; only an attorney touches
 * anyone else's.** Corrections are attorney-only outright — letting
 * someone silently rewrite their own punches would make the record
 * worth nothing, which is the same reason the trust ledger and audit log
 * are append-only.
 *
 * `postToPayroll` is the bridge to `payroll.ts`. It converts a completed
 * shift into a worked-hours entry (where a rate turns it into gross
 * pay) and marks the shift posted, so the same hours can't be paid
 * twice. Posting is attorney-only and audited, and once posted the
 * shift can no longer be adjusted — the payroll entry is the record
 * from that point on.
 */
/**
 * "Every logged-in human" here means every *staff* role — written
 * before the client portal existed. A client is never an employee of
 * the firm, so `"client"` is denied by name, same as `"system"`.
 */
function requireHuman(actor: Actor): void {
  if (actor.role === "system" || actor.role === "client") {
    throw new AccessDeniedError("the time clock is not available to this role");
  }
}

function requireSelfOrAttorney(actor: Actor, actorId: string, what: string): void {
  requireHuman(actor);
  if (actor.id !== actorId && actor.role !== "attorney") {
    throw new AccessDeniedError(`${what} for another person is attorney-only`);
  }
}

export interface TimeClockSummary {
  actorId: string;
  timeZone: string;
  openShift: ShiftView | undefined;
  today: TimeBucket | undefined;
  thisWeek: TimeBucket | undefined;
  thisMonth: TimeBucket | undefined;
}

export class TimeClockService {
  #clock: TimeClock;
  #payroll: PayrollStore;
  #auditLog: AuditLog;
  #defaultTimeZone: string;

  constructor(params: { clock: TimeClock; payroll: PayrollStore; auditLog: AuditLog; defaultTimeZone?: string }) {
    this.#clock = params.clock;
    this.#payroll = params.payroll;
    this.#auditLog = params.auditLog;
    this.#defaultTimeZone = params.defaultTimeZone ?? "UTC";
  }

  get defaultTimeZone(): string {
    return this.#defaultTimeZone;
  }

  /** Punching is always self-service — you can't clock someone else in. */
  clockIn(actor: Actor, note?: string): Shift {
    requireHuman(actor);
    const shift = this.#clock.clockIn(actor.id, note);
    this.#auditLog.append({ actor, matterId: undefined, action: "clock_in", detail: `shift=${shift.id}` });
    return shift;
  }

  clockOut(actor: Actor, note?: string): Shift {
    requireHuman(actor);
    const shift = this.#clock.clockOut(actor.id, note);
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "clock_out",
      detail: `shift=${shift.id} in=${shift.clockInAt} out=${shift.clockOutAt}`,
    });
    return shift;
  }

  listShifts(actor: Actor, actorId: string, timeZone?: string, fromDate?: string, toDate?: string): ShiftView[] {
    requireSelfOrAttorney(actor, actorId, "viewing timesheets");
    return this.#clock.listShifts(actorId, timeZone ?? this.#defaultTimeZone, fromDate, toDate);
  }

  totals(
    actor: Actor,
    actorId: string,
    kind: BucketKind,
    timeZone?: string,
    fromDate?: string,
    toDate?: string,
  ): TimeBucket[] {
    requireSelfOrAttorney(actor, actorId, "viewing timesheets");
    return this.#clock.totals(actorId, kind, timeZone ?? this.#defaultTimeZone, fromDate, toDate);
  }

  /** The at-a-glance view: am I on the clock, and how much have I done today / this week / this month. */
  summary(actor: Actor, actorId: string, timeZone?: string): TimeClockSummary {
    requireSelfOrAttorney(actor, actorId, "viewing timesheets");
    const tz = timeZone ?? this.#defaultTimeZone;
    const today = this.#clock.today(tz);

    const open = this.#clock.openShifts(tz).find((s) => s.actorId === actorId);
    const dayBucket = this.#clock.totals(actorId, "day", tz, today, today)[0];
    const weekBuckets = this.#clock.totals(actorId, "week", tz);
    const monthBuckets = this.#clock.totals(actorId, "month", tz);

    return {
      actorId,
      timeZone: tz,
      openShift: open,
      today: dayBucket,
      // The bucket containing today, not merely the most recent one — a
      // gap in punching shouldn't make last week look like this week.
      thisWeek: weekBuckets.find((b) => b.startDate <= today && today < addDays(b.startDate, 7)),
      thisMonth: monthBuckets.find((b) => b.key === today.slice(0, 7)),
    };
  }

  /** Everyone currently on the clock. Attorney-only: it's a view of other people's whereabouts. */
  whoIsOnTheClock(actor: Actor, timeZone?: string): ShiftView[] {
    requireHuman(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("seeing everyone currently on the clock is attorney-only");
    }
    return this.#clock.openShifts(timeZone ?? this.#defaultTimeZone);
  }

  /**
   * Corrects a punch. Attorney-only even for your own shifts: a
   * timesheet you can silently rewrite isn't a record, and this is the
   * input to what people get paid.
   */
  adjust(actor: Actor, shiftId: string, params: { clockInAt?: string; clockOutAt?: string; reason: string }): Shift {
    requireHuman(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("correcting a punch is attorney-only — including your own");
    }
    const shift = this.#clock.adjust(shiftId, {
      ...(params.clockInAt ? { clockInAt: params.clockInAt } : {}),
      ...(params.clockOutAt ? { clockOutAt: params.clockOutAt } : {}),
      by: actor.id,
      reason: params.reason,
    });
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "shift_adjusted",
      detail: `shift=${shift.id} subject=${shift.actorId} reason=${params.reason} in=${shift.clockInAt} out=${shift.clockOutAt}`,
    });
    return shift;
  }

  /**
   * Turns a completed shift into a payroll worked-hours entry. Marking
   * the shift posted happens *after* the payroll entry exists, so a
   * failure can't leave a shift marked as paid when it isn't.
   */
  postToPayroll(actor: Actor, shiftId: string): { shift: Shift; entry: WorkedHoursEntry } {
    requireHuman(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("posting hours to payroll is attorney-only");
    }
    const shift = this.#clock.get(shiftId);
    if (!shift) throw new TimeClockError(`no shift '${shiftId}'`, "not_found");
    if (!shift.clockOutAt) throw new TimeClockError("an open shift can't be posted to payroll — clock out first");
    if (shift.postedPayrollEntryId) throw new TimeClockError(`shift '${shiftId}' has already been posted to payroll`);

    const durationMs = Date.parse(shift.clockOutAt) - Date.parse(shift.clockInAt);
    const hoursMilli = msToHoursMilli(durationMs);
    // Payroll refuses non-positive hours, and would do so here with a
    // message about `hoursMilli` that means nothing to whoever clicked
    // the button. Say what actually happened instead.
    if (hoursMilli <= 0) {
      throw new TimeClockError(
        "this shift is shorter than a minute — correct the punch times before posting it to payroll",
        "invalid",
      );
    }
    const entry = this.#payroll.recordHours({
      actorId: shift.actorId,
      date: this.#clock.listShifts(shift.actorId, this.#defaultTimeZone).find((s) => s.id === shiftId)!.localDate,
      hoursMilli,
      description: shift.note ? `Clocked shift — ${shift.note}` : "Clocked shift",
      recordedBy: actor.id,
    });
    this.#clock.markPosted(shiftId, entry.id);
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "shift_posted_to_payroll",
      detail: `shift=${shiftId} subject=${shift.actorId} entry=${entry.id} hoursMilli=${entry.hoursMilli}`,
    });
    return { shift, entry };
  }
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
