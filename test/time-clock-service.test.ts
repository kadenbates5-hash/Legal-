import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit.js";
import { PayrollStore } from "../src/core/payroll.js";
import { TimeClock, TimeClockError } from "../src/core/time-clock.js";
import { TimeClockService } from "../src/review-ui/time-clock-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const otherParalegal: Actor = { id: "p2", role: "paralegal" };
const machine: Actor = { id: "calendar", role: "system" };

function makeService(now?: string) {
  const auditLog = new AuditLog();
  const payroll = new PayrollStore();
  const clock = new TimeClock(now ? { now: () => new Date(now) } : {});
  return {
    auditLog,
    payroll,
    clock,
    service: new TimeClockService({ clock, payroll, auditLog, defaultTimeZone: "America/New_York" }),
  };
}

/** Re-points the service's clock at a new instant, keeping the recorded shifts. */
function advanceTo(existing: ReturnType<typeof makeService>, iso: string) {
  const clock = TimeClock.fromSnapshot(existing.clock.toSnapshot(), { now: () => new Date(iso) });
  return {
    ...existing,
    clock,
    service: new TimeClockService({
      clock,
      payroll: existing.payroll,
      auditLog: existing.auditLog,
      defaultTimeZone: "America/New_York",
    }),
  };
}

describe("TimeClockService — punching", () => {
  it("only ever punches your own clock, whatever your role", () => {
    const { service, clock } = makeService("2026-07-20T13:00:00Z");
    service.clockIn(attorney);
    // The attorney's punch landed on the attorney, not on anyone they might have picked.
    expect(clock.openShift("a1")).toBeDefined();
    expect(clock.openShift("p1")).toBeUndefined();
  });

  it("audits both ends of a shift", () => {
    let ctx = makeService("2026-07-20T13:00:00Z");
    ctx.service.clockIn(paralegal, "at the courthouse");
    ctx = advanceTo(ctx, "2026-07-20T17:00:00Z");
    ctx.service.clockOut(paralegal);
    const actions = ctx.auditLog.read("attorney").map((e) => e.action);
    expect(actions).toContain("clock_in");
    expect(actions).toContain("clock_out");
  });

  it("refuses the system credential outright — a machine has no timesheet", () => {
    const { service } = makeService();
    expect(() => service.clockIn(machine)).toThrow(AccessDeniedError);
    expect(() => service.whoIsOnTheClock(machine)).toThrow(AccessDeniedError);
  });
});

describe("TimeClockService — who may see whose timesheet", () => {
  it("lets you see your own and an attorney see anyone's", () => {
    const { service } = makeService("2026-07-20T13:00:00Z");
    service.clockIn(paralegal);
    expect(service.listShifts(paralegal, "p1")).toHaveLength(1);
    expect(service.listShifts(attorney, "p1")).toHaveLength(1);
    expect(() => service.listShifts(otherParalegal, "p1")).toThrow(AccessDeniedError);
    expect(() => service.totals(otherParalegal, "p1", "day")).toThrow(AccessDeniedError);
    expect(() => service.summary(otherParalegal, "p1")).toThrow(AccessDeniedError);
  });

  it("keeps the firm-wide 'who is on the clock' view attorney-only", () => {
    const { service } = makeService("2026-07-20T13:00:00Z");
    service.clockIn(paralegal);
    expect(() => service.whoIsOnTheClock(paralegal)).toThrow(AccessDeniedError);
    expect(service.whoIsOnTheClock(attorney)).toHaveLength(1);
  });
});

describe("TimeClockService — summary", () => {
  it("reports the open shift plus today, this week and this month", () => {
    // 9am-1pm Monday, then clocked in again at 3pm and still going.
    let ctx = makeService("2026-07-20T13:00:00Z"); // 9am New York
    ctx.service.clockIn(paralegal);
    ctx = advanceTo(ctx, "2026-07-20T17:00:00Z"); // 1pm
    ctx.service.clockOut(paralegal);
    ctx = advanceTo(ctx, "2026-07-20T19:00:00Z"); // 3pm
    ctx.service.clockIn(paralegal);

    const summary = ctx.service.summary(paralegal, "p1");
    expect(summary.timeZone).toBe("America/New_York");
    expect(summary.openShift?.clockInAt).toBe("2026-07-20T19:00:00.000Z");
    // The still-open second shift is deliberately not in any total.
    expect(summary.today?.totalMs).toBe(4 * 60 * 60 * 1000);
    expect(summary.thisWeek?.totalMs).toBe(4 * 60 * 60 * 1000);
    expect(summary.thisMonth?.totalMs).toBe(4 * 60 * 60 * 1000);
  });

  it("returns the bucket containing today, not merely the most recent one", () => {
    // A shift three weeks ago and nothing since: this week is empty, and
    // must read as empty rather than showing the old week's hours.
    let ctx = makeService("2026-06-29T13:00:00Z");
    ctx.service.clockIn(paralegal);
    ctx = advanceTo(ctx, "2026-06-29T21:00:00Z");
    ctx.service.clockOut(paralegal);
    ctx = advanceTo(ctx, "2026-07-22T15:00:00Z");

    const summary = ctx.service.summary(paralegal, "p1");
    expect(summary.thisWeek).toBeUndefined();
    expect(summary.thisMonth).toBeUndefined();
    expect(summary.openShift).toBeUndefined();
  });

  it("buckets an evening shift on the firm's day, not UTC's", () => {
    // 9pm-11pm Monday in New York is 01:00-03:00 Tuesday in UTC.
    let ctx = makeService("2026-07-21T01:00:00Z");
    ctx.service.clockIn(paralegal);
    ctx = advanceTo(ctx, "2026-07-21T03:00:00Z");
    ctx.service.clockOut(paralegal);

    expect(ctx.service.totals(paralegal, "p1", "day")[0]!.key).toBe("2026-07-20");
    expect(ctx.service.totals(paralegal, "p1", "day", "UTC")[0]!.key).toBe("2026-07-21");
  });
});

describe("TimeClockService — corrections", () => {
  it("refuses to let someone correct their own punch", () => {
    const { service, clock } = makeService("2026-07-20T13:00:00Z");
    const shift = service.clockIn(paralegal);
    expect(() =>
      service.adjust(paralegal, shift.id, { clockOutAt: "2026-07-20T23:00:00Z", reason: "forgot" }),
    ).toThrow(AccessDeniedError);
    expect(clock.get(shift.id)!.clockOutAt).toBeUndefined();
  });

  it("lets an attorney fix a forgotten clock-out, keeping the original on the record", () => {
    const { service, auditLog } = makeService("2026-07-20T13:00:00Z");
    const shift = service.clockIn(paralegal);
    const fixed = service.adjust(attorney, shift.id, {
      clockOutAt: "2026-07-20T21:00:00Z",
      reason: "forgot to clock out",
    });
    expect(fixed.corrections).toHaveLength(1);
    expect(fixed.corrections[0]!.by).toBe("a1");
    expect(auditLog.read("attorney").some((e) => e.action === "shift_adjusted")).toBe(true);
  });

  it("surfaces a missing shift as a not-found error rather than an access error", () => {
    const { service } = makeService();
    expect(() => service.adjust(attorney, "shift_999", { reason: "x" })).toThrow(TimeClockError);
  });
});

describe("TimeClockService — posting to payroll", () => {
  function completedShift() {
    let ctx = makeService("2026-07-20T13:00:00Z");
    ctx.service.clockIn(paralegal);
    ctx = advanceTo(ctx, "2026-07-20T20:30:00Z"); // 7.5 hours
    ctx.service.clockOut(paralegal);
    return ctx;
  }

  it("turns a shift into priced payroll hours", () => {
    const ctx = completedShift();
    ctx.payroll.setRate({ actorId: "p1", hourlyCents: 30_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    const shiftId = ctx.service.listShifts(attorney, "p1")[0]!.id;

    const { entry } = ctx.service.postToPayroll(attorney, shiftId);
    expect(entry.hoursMilli).toBe(7_500);
    // Dated on the local day worked, so it lands in the right pay period.
    expect(entry.date).toBe("2026-07-20");
    expect(ctx.payroll.summarize("2026-07-01", "2026-07-31").totalGrossPayCents).toBe(225_00);
  });

  it("keeps posting attorney-only", () => {
    const ctx = completedShift();
    const shiftId = ctx.service.listShifts(paralegal, "p1")[0]!.id;
    expect(() => ctx.service.postToPayroll(paralegal, shiftId)).toThrow(AccessDeniedError);
  });

  it("refuses to post the same shift twice, so hours can't be paid twice", () => {
    const ctx = completedShift();
    const shiftId = ctx.service.listShifts(attorney, "p1")[0]!.id;
    ctx.service.postToPayroll(attorney, shiftId);
    expect(() => ctx.service.postToPayroll(attorney, shiftId)).toThrow(/already been posted/i);
    expect(ctx.payroll.listHours("p1")).toHaveLength(1);
  });

  it("refuses to post an open shift", () => {
    const { service } = makeService("2026-07-20T13:00:00Z");
    const shift = service.clockIn(paralegal);
    expect(() => service.postToPayroll(attorney, shift.id)).toThrow(/clock out first/i);
  });

  it("locks the shift against correction once it is payroll's record", () => {
    const ctx = completedShift();
    const shiftId = ctx.service.listShifts(attorney, "p1")[0]!.id;
    ctx.service.postToPayroll(attorney, shiftId);
    expect(() =>
      ctx.service.adjust(attorney, shiftId, { clockOutAt: "2026-07-20T23:00:00Z", reason: "late" }),
    ).toThrow(/already been posted/i);
  });

  it("records nothing in payroll when the shift itself is rejected", () => {
    const ctx = completedShift();
    expect(() => ctx.service.postToPayroll(attorney, "shift_999")).toThrow(TimeClockError);
    expect(ctx.payroll.listHours("p1")).toHaveLength(0);
  });
});
