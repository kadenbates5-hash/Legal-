import { describe, expect, it } from "vitest";
import { TimeClock, TimeClockError, type TimeClockSnapshot } from "../src/core/time-clock.js";

/**
 * A corrected punch becomes someone's pay. Each of these used to be
 * stored: a time with no zone (read in the server's zone), a time in the
 * future, and a correction that made two shifts cover the same hours.
 */
const at = (iso: string) => ({ now: () => new Date(iso) });

/** p1 worked 09:00–17:00 on the 20th (left open) and 09:00–17:00 on the 21st; it's now the 22nd. */
function clockWithTwoShifts(): { clock: TimeClock; first: string; second: string } {
  const monday = new TimeClock(at("2026-07-20T09:00:00Z"));
  const first = monday.clockIn("p1").id;
  const snapshot: TimeClockSnapshot = monday.toSnapshot();
  // The first shift's clock-out was forgotten; a second shift followed the next day.
  snapshot.shifts.push({
    id: "shift_2",
    actorId: "p1",
    clockInAt: "2026-07-21T09:00:00.000Z",
    clockOutAt: "2026-07-21T17:00:00.000Z",
    note: undefined,
    postedPayrollEntryId: undefined,
    corrections: [],
  });
  snapshot.nextId = 3;
  return { clock: TimeClock.fromSnapshot(snapshot, at("2026-07-22T12:00:00Z")), first, second: "shift_2" };
}

function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof TimeClockError ? err.kind : "other";
  }
  return undefined;
}

describe("correcting a punch", () => {
  it("refuses a time without its zone, which the server read in its own zone", () => {
    const { clock, first } = clockWithTwoShifts();
    for (const clockOutAt of ["2026-07-20T17:00", "2026-07-20 17:00", "July 20 2026 5:00 PM", "17:00"]) {
      expect(kindOf(() => clock.adjust(first, { clockOutAt, by: "a1", reason: "forgot" })), clockOutAt).toBe("invalid");
    }
    expect(clock.get(first)!.clockOutAt).toBeUndefined();
  });

  it("stores a zoned time as the instant it names", () => {
    const { clock, first } = clockWithTwoShifts();
    const fixed = clock.adjust(first, { clockOutAt: "2026-07-20T13:00:00-04:00", by: "a1", reason: "forgot" });
    expect(fixed.clockOutAt).toBe("2026-07-20T17:00:00.000Z");
  });

  it("refuses a punch in the future", () => {
    const { clock, second } = clockWithTwoShifts();
    expect(kindOf(() => clock.adjust(second, { clockOutAt: "2026-07-23T17:00:00Z", by: "a1", reason: "x" }))).toBe("invalid");
    expect(() => clock.adjust(second, { clockOutAt: "2026-07-23T17:00:00Z", by: "a1", reason: "x" })).toThrow(/future/);
  });

  it("refuses a correction that would count the same hours twice", () => {
    const { clock, first, second } = clockWithTwoShifts();
    // The forgotten clock-out "fixed" to the next morning, after the next shift began.
    expect(kindOf(() => clock.adjust(first, { clockOutAt: "2026-07-21T10:00:00Z", by: "a1", reason: "forgot" }))).toBe("conflict");
    // Or the second shift moved back over the first.
    clock.adjust(first, { clockOutAt: "2026-07-20T17:00:00Z", by: "a1", reason: "forgot" });
    expect(kindOf(() => clock.adjust(second, { clockInAt: "2026-07-20T16:00:00Z", by: "a1", reason: "typo" }))).toBe("conflict");
    expect(clock.get(second)!.clockInAt).toBe("2026-07-21T09:00:00.000Z");
    // Touching end to start is not an overlap.
    expect(clock.adjust(second, { clockInAt: "2026-07-20T17:00:00Z", by: "a1", reason: "typo" }).clockInAt).toBe(
      "2026-07-20T17:00:00.000Z",
    );
  });

  it("doesn't let a correction run into a shift that's still open", () => {
    const tuesday = new TimeClock(at("2026-07-21T08:00:00Z"));
    const done = tuesday.clockIn("p1");
    const snapshot = tuesday.toSnapshot();
    snapshot.shifts[0]!.clockOutAt = "2026-07-21T09:00:00.000Z";
    const clock = TimeClock.fromSnapshot(snapshot, at("2026-07-21T11:00:00Z"));
    clock.clockIn("p1"); // open since 11:00
    const later = TimeClock.fromSnapshot(clock.toSnapshot(), at("2026-07-21T13:00:00Z"));
    expect(kindOf(() => later.adjust(done.id, { clockOutAt: "2026-07-21T11:30:00Z", by: "a1", reason: "x" }))).toBe("conflict");
    // Someone else's shifts don't matter.
    later.clockIn("p2");
    expect(later.adjust(done.id, { clockOutAt: "2026-07-21T10:30:00Z", by: "a1", reason: "x" }).clockOutAt).toBe(
      "2026-07-21T10:30:00.000Z",
    );
  });
});
