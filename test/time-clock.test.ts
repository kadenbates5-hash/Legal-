import { describe, expect, it } from "vitest";
import { TimeClock, TimeClockError, formatDuration, msToHoursMilli } from "../src/core/time-clock.js";

/** Controllable clock, so shifts can be placed at exact instants. */
function at(iso: string) {
  return { now: () => new Date(iso) };
}

function clockWithShift(inAt: string, outAt: string, actorId = "p1") {
  const clock = new TimeClock(at(inAt));
  clock.clockIn(actorId);
  // Re-point "now" at the clock-out instant.
  const out = new TimeClock(at(outAt));
  const snapshot = clock.toSnapshot();
  const restored = TimeClock.fromSnapshot(snapshot, at(outAt));
  restored.clockOut(actorId);
  void out;
  return restored;
}

describe("TimeClock — punching", () => {
  it("records a shift and computes its duration from the timestamps", () => {
    const clock = clockWithShift("2026-07-20T13:00:00Z", "2026-07-20T20:30:00Z");
    const [shift] = clock.listShifts("p1", "UTC");
    expect(shift!.open).toBe(false);
    expect(formatDuration(shift!.durationMs)).toBe("7h 30m");
  });

  it("refuses a second clock-in while a shift is open", () => {
    const clock = new TimeClock(at("2026-07-20T13:00:00Z"));
    clock.clockIn("p1");
    expect(() => clock.clockIn("p1")).toThrow(/already clocked in/i);
  });

  it("refuses a clock-out when not clocked in", () => {
    expect(() => new TimeClock().clockOut("p1")).toThrow(/not currently clocked in/i);
  });

  it("keeps different people's shifts independent", () => {
    const clock = new TimeClock(at("2026-07-20T13:00:00Z"));
    clock.clockIn("p1");
    expect(() => clock.clockIn("p2")).not.toThrow();
    expect(clock.openShifts("UTC")).toHaveLength(2);
  });

  it("lets someone clock in again once the previous shift is closed", () => {
    const clock = clockWithShift("2026-07-20T13:00:00Z", "2026-07-20T17:00:00Z");
    expect(() => clock.clockIn("p1")).not.toThrow();
  });
});

describe("TimeClock — local day boundaries", () => {
  it("buckets an evening shift on the local day, not the UTC day", () => {
    // 9pm-11pm in New York is 01:00-03:00 the *next* day in UTC.
    const clock = clockWithShift("2026-07-21T01:00:00Z", "2026-07-21T03:00:00Z");
    expect(clock.listShifts("p1", "UTC")[0]!.localDate).toBe("2026-07-21");
    expect(clock.listShifts("p1", "America/New_York")[0]!.localDate).toBe("2026-07-20");
  });

  it("puts those hours in the right daily bucket for the firm's timezone", () => {
    const clock = clockWithShift("2026-07-21T01:00:00Z", "2026-07-21T03:00:00Z");
    expect(clock.totals("p1", "day", "America/New_York")[0]!.key).toBe("2026-07-20");
    expect(clock.totals("p1", "day", "UTC")[0]!.key).toBe("2026-07-21");
  });

  it("rejects a timezone it doesn't recognise rather than silently using UTC", () => {
    const clock = new TimeClock();
    expect(() => clock.listShifts("p1", "Mars/Olympus")).toThrow(/not a recognised IANA timezone/i);
  });
});

describe("TimeClock — totals", () => {
  function week() {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    const punches: [string, string][] = [
      ["2026-07-20T09:00:00Z", "2026-07-20T17:00:00Z"], // Mon 8h
      ["2026-07-21T09:00:00Z", "2026-07-21T13:00:00Z"], // Tue 4h
      ["2026-07-27T09:00:00Z", "2026-07-27T15:00:00Z"], // next Mon 6h
      ["2026-08-03T09:00:00Z", "2026-08-03T12:00:00Z"], // Aug 3h
    ];
    let current = clock;
    for (const [i, o] of punches) {
      current = TimeClock.fromSnapshot(current.toSnapshot(), at(i));
      current.clockIn("p1");
      current = TimeClock.fromSnapshot(current.toSnapshot(), at(o));
      current.clockOut("p1");
    }
    return current;
  }

  it("totals by day", () => {
    const totals = week().totals("p1", "day", "UTC");
    expect(totals.map((b) => [b.key, formatDuration(b.totalMs)])).toEqual([
      ["2026-07-20", "8h 00m"],
      ["2026-07-21", "4h 00m"],
      ["2026-07-27", "6h 00m"],
      ["2026-08-03", "3h 00m"],
    ]);
  });

  it("totals by ISO week, Monday-start", () => {
    const totals = week().totals("p1", "week", "UTC");
    expect(totals.map((b) => [b.startDate, formatDuration(b.totalMs)])).toEqual([
      ["2026-07-20", "12h 00m"], // Mon + Tue
      ["2026-07-27", "6h 00m"],
      ["2026-08-03", "3h 00m"],
    ]);
  });

  it("totals by month", () => {
    const totals = week().totals("p1", "month", "UTC");
    expect(totals.map((b) => [b.key, formatDuration(b.totalMs)])).toEqual([
      ["2026-07", "18h 00m"],
      ["2026-08", "3h 00m"],
    ]);
  });

  it("excludes an open shift, so a total doesn't change every time you look at it", () => {
    const clock = clockWithShift("2026-07-20T09:00:00Z", "2026-07-20T17:00:00Z");
    clock.clockIn("p1"); // still open
    const totals = clock.totals("p1", "day", "UTC");
    expect(totals).toHaveLength(1);
    expect(formatDuration(totals[0]!.totalMs)).toBe("8h 00m");
  });

  it("attributes an overnight shift to the day it started", () => {
    const clock = clockWithShift("2026-07-20T22:00:00Z", "2026-07-21T02:00:00Z");
    const totals = clock.totals("p1", "day", "UTC");
    expect(totals).toHaveLength(1);
    expect(totals[0]!.key).toBe("2026-07-20");
    expect(formatDuration(totals[0]!.totalMs)).toBe("4h 00m");
  });

  it("respects a local date range", () => {
    const totals = week().totals("p1", "day", "UTC", "2026-07-21", "2026-07-27");
    expect(totals.map((b) => b.key)).toEqual(["2026-07-21", "2026-07-27"]);
  });
});

describe("TimeClock — forgotten clock-outs", () => {
  it("flags an open shift older than the stale threshold", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    clock.clockIn("p1");
    const nextDay = TimeClock.fromSnapshot(clock.toSnapshot(), at("2026-07-21T09:00:00Z"));
    expect(nextDay.openShifts("UTC")[0]!.likelyForgotten).toBe(true);
  });

  it("does not flag an ordinary in-progress shift", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    clock.clockIn("p1");
    const later = TimeClock.fromSnapshot(clock.toSnapshot(), at("2026-07-20T13:00:00Z"));
    expect(later.openShifts("UTC")[0]!.likelyForgotten).toBe(false);
  });

  it("corrects a forgotten punch, keeping the original values on the record", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    const shift = clock.clockIn("p1");
    const fixed = clock.adjust(shift.id, {
      clockOutAt: "2026-07-20T17:00:00Z",
      by: "a1",
      reason: "forgot to clock out",
    });
    expect(fixed.corrections).toHaveLength(1);
    expect(fixed.corrections[0]!.previousClockOutAt).toBeUndefined();
    expect(fixed.corrections[0]!.reason).toBe("forgot to clock out");
    expect(formatDuration(clock.listShifts("p1", "UTC")[0]!.durationMs)).toBe("8h 00m");
  });

  it("requires a reason for a correction", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    const shift = clock.clockIn("p1");
    expect(() => clock.adjust(shift.id, { clockOutAt: "2026-07-20T17:00:00Z", by: "a1", reason: " " })).toThrow(/reason/i);
  });

  it("refuses a correction that ends before it starts", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    const shift = clock.clockIn("p1");
    expect(() =>
      clock.adjust(shift.id, { clockOutAt: "2026-07-20T08:00:00Z", by: "a1", reason: "typo" }),
    ).toThrow(/must end after it starts/i);
  });
});

describe("TimeClock — posting to payroll", () => {
  it("refuses to post an open shift", () => {
    const clock = new TimeClock(at("2026-07-20T09:00:00Z"));
    const shift = clock.clockIn("p1");
    expect(() => clock.markPosted(shift.id, "worked_1")).toThrow(/clock out first/i);
  });

  it("refuses to post the same shift twice", () => {
    const clock = clockWithShift("2026-07-20T09:00:00Z", "2026-07-20T17:00:00Z");
    const shift = clock.listShifts("p1", "UTC")[0]!;
    clock.markPosted(shift.id, "worked_1");
    expect(() => clock.markPosted(shift.id, "worked_2")).toThrow(/already been posted/i);
  });

  it("refuses to correct a shift already posted to payroll, so the two can't disagree", () => {
    const clock = clockWithShift("2026-07-20T09:00:00Z", "2026-07-20T17:00:00Z");
    const shift = clock.listShifts("p1", "UTC")[0]!;
    clock.markPosted(shift.id, "worked_1");
    expect(() =>
      clock.adjust(shift.id, { clockOutAt: "2026-07-20T18:00:00Z", by: "a1", reason: "late" }),
    ).toThrow(/already been posted/i);
  });

  it("converts to the thousandths-of-an-hour unit payroll prices in", () => {
    expect(msToHoursMilli(7.5 * 3_600_000)).toBe(7_500);
    expect(msToHoursMilli(90 * 60_000)).toBe(1_500);
  });
});

describe("TimeClock — persistence", () => {
  it("round-trips shifts, corrections and the id counter", () => {
    const clock = clockWithShift("2026-07-20T09:00:00Z", "2026-07-20T17:00:00Z");
    const restored = TimeClock.fromSnapshot(clock.toSnapshot(), at("2026-07-21T09:00:00Z"));
    expect(formatDuration(restored.totals("p1", "day", "UTC")[0]!.totalMs)).toBe("8h 00m");
    // Rules survive the reload: still can't double-punch after clocking in.
    restored.clockIn("p1");
    expect(() => restored.clockIn("p1")).toThrow(TimeClockError);
  });
});
