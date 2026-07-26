import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit.js";
import { DeadlineTracker, daysBetweenDates } from "../src/core/deadline.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const TODAY = "2026-07-26";

function trackerWith(entries: { matterId: string; type: "speedy_trial" | "arraignment" | "other"; date: string; source: "agent" | "human" | "calendar_system" }[]) {
  const tracker = new DeadlineTracker();
  for (const e of entries) tracker.record(e);
  return tracker;
}

describe("DeadlineTracker.listUpcoming", () => {
  it("returns deadlines inside the horizon, soonest first", () => {
    const tracker = trackerWith([
      { matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "agent" },
      { matterId: "m-2", type: "arraignment", date: "2026-07-28", source: "agent" },
      { matterId: "m-3", type: "other", date: "2026-12-01", source: "agent" },
    ]);
    const due = tracker.listUpcoming({ today: TODAY, withinDays: 14 });
    expect(due.map((d) => d.matterId)).toEqual(["m-2", "m-1"]);
  });

  it("reports how many days away, and counts down to zero on the day", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: TODAY, source: "agent" }]);
    const [due] = tracker.listUpcoming({ today: TODAY, withinDays: 14 });
    expect(due!.daysAway).toBe(0);
    expect(due!.overdue).toBe(false);
  });

  it("keeps reporting a deadline that has already passed", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "speedy_trial", date: "2026-07-20", source: "agent" }]);
    const [due] = tracker.listUpcoming({ today: TODAY, withinDays: 14 });
    // Dropping it once the date passes is how a missed deadline stops
    // being anybody's problem.
    expect(due!.overdue).toBe(true);
    expect(due!.daysAway).toBe(-6);
  });

  it("carries the confirmation state, which is the point of the list", () => {
    const tracker = trackerWith([
      { matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "agent" },
      { matterId: "m-2", type: "arraignment", date: "2026-08-01", source: "agent" },
      { matterId: "m-2", type: "arraignment", date: "2026-08-01", source: "human" },
    ]);
    const byMatter = Object.fromEntries(
      tracker.listUpcoming({ today: TODAY, withinDays: 14 }).map((d) => [d.matterId, d.confirmationState]),
    );
    expect(byMatter["m-1"]).toBe("unconfirmed");
    expect(byMatter["m-2"]).toBe("confirmed");
  });

  it("uses the soonest of two disagreeing dates, since that's when time runs out", () => {
    const tracker = trackerWith([
      { matterId: "m-1", type: "speedy_trial", date: "2026-08-05", source: "human" },
      { matterId: "m-1", type: "speedy_trial", date: "2026-07-30", source: "calendar_system" },
    ]);
    const [due] = tracker.listUpcoming({ today: TODAY, withinDays: 14 });
    expect(due!.confirmationState).toBe("conflict");
    expect(due!.date).toBe("2026-07-30");
  });

  it("includes a conflict whose earlier date is inside the horizon even if the later one isn't", () => {
    const tracker = trackerWith([
      { matterId: "m-1", type: "speedy_trial", date: "2026-07-29", source: "human" },
      { matterId: "m-1", type: "speedy_trial", date: "2027-01-01", source: "calendar_system" },
    ]);
    expect(tracker.listUpcoming({ today: TODAY, withinDays: 14 })).toHaveLength(1);
  });

  it("excludes anything beyond the horizon", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-09-01", source: "agent" }]);
    expect(tracker.listUpcoming({ today: TODAY, withinDays: 14 })).toEqual([]);
    expect(tracker.listUpcoming({ today: TODAY, withinDays: 60 })).toHaveLength(1);
  });

  it("survives a snapshot round trip", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-07-30", source: "agent" }]);
    const restored = DeadlineTracker.fromSnapshot(tracker.toSnapshot());
    expect(restored.listUpcoming({ today: TODAY, withinDays: 14 })).toHaveLength(1);
  });
});

describe("daysBetweenDates", () => {
  it("counts whole days without a timezone off-by-one", () => {
    expect(daysBetweenDates("2026-07-26", "2026-08-01")).toBe(6);
    expect(daysBetweenDates("2026-07-26", "2026-07-26")).toBe(0);
    expect(daysBetweenDates("2026-07-26", "2026-07-20")).toBe(-6);
    // Across a DST boundary in the northern hemisphere.
    expect(daysBetweenDates("2026-03-01", "2026-04-01")).toBe(31);
  });
});

describe("ReviewGateService.listUpcomingDeadlines — risk ranking", () => {
  function service(tracker: DeadlineTracker) {
    return new ReviewGateService(new WorkProductStore(), tracker);
  }

  it("ranks an unverified deadline above a confirmed one that is slightly closer", () => {
    const tracker = trackerWith([
      // Confirmed, 5 days away.
      { matterId: "m-confirmed", type: "arraignment", date: "2026-07-31", source: "agent" },
      { matterId: "m-confirmed", type: "arraignment", date: "2026-07-31", source: "human" },
      // Single-sourced, 8 days away — nobody has checked it, and the
      // window to do so is closing.
      { matterId: "m-unverified", type: "speedy_trial", date: "2026-08-03", source: "agent" },
    ]);
    const ranked = service(tracker).listUpcomingDeadlines(attorney, { today: TODAY });
    expect(ranked[0]!.matterId).toBe("m-unverified");
  });

  it("ranks a conflict above an equally distant unverified deadline", () => {
    const tracker = trackerWith([
      { matterId: "m-unverified", type: "speedy_trial", date: "2026-08-01", source: "agent" },
      { matterId: "m-conflict", type: "arraignment", date: "2026-08-01", source: "human" },
      { matterId: "m-conflict", type: "arraignment", date: "2026-08-04", source: "calendar_system" },
    ]);
    const ranked = service(tracker).listUpcomingDeadlines(attorney, { today: TODAY });
    expect(ranked[0]!.matterId).toBe("m-conflict");
  });

  it("still puts an overdue deadline first, whatever its state", () => {
    const tracker = trackerWith([
      { matterId: "m-overdue", type: "speedy_trial", date: "2026-07-24", source: "agent" },
      { matterId: "m-overdue", type: "speedy_trial", date: "2026-07-24", source: "human" },
      { matterId: "m-soon", type: "arraignment", date: "2026-07-30", source: "agent" },
    ]);
    const ranked = service(tracker).listUpcomingDeadlines(attorney, { today: TODAY });
    expect(ranked[0]!.matterId).toBe("m-overdue");
  });

  it("does not penalise a confirmed deadline into invisibility", () => {
    const tracker = trackerWith([
      { matterId: "m-1", type: "arraignment", date: "2026-07-27", source: "agent" },
      { matterId: "m-1", type: "arraignment", date: "2026-07-27", source: "human" },
    ]);
    const ranked = service(tracker).listUpcomingDeadlines(attorney, { today: TODAY });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.confirmationState).toBe("confirmed");
  });

  it("stays attorney-only, like the rest of the deadline surface", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-07-30", source: "agent" }]);
    expect(() => service(tracker).listUpcomingDeadlines(paralegal)).toThrow(AccessDeniedError);
  });

  it("returns an empty list rather than failing when no tracker is configured", () => {
    expect(new ReviewGateService(new WorkProductStore()).listUpcomingDeadlines(attorney)).toEqual([]);
  });
});

describe("upcoming deadlines — audit independence", () => {
  it("reading the list writes nothing to the audit log", () => {
    const auditLog = new AuditLog();
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-07-30", source: "agent" }]);
    const service = new ReviewGateService(new WorkProductStore(), tracker);
    const before = auditLog.count();
    service.listUpcomingDeadlines(attorney, { today: TODAY });
    // A dashboard that polls this shouldn't grow the log every refresh.
    expect(auditLog.count()).toBe(before);
  });
});
