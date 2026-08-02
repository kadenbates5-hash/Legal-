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

  it("stays attorney-only for other roles, like the rest of the deadline surface", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-07-30", source: "agent" }]);
    expect(() => service(tracker).listUpcomingDeadlines(paralegal)).toThrow(AccessDeniedError);
  });

  it("is also reachable by the system credential, for the deadline-alert sending job", () => {
    const tracker = trackerWith([{ matterId: "m-1", type: "other", date: "2026-07-30", source: "agent" }]);
    const system: Actor = { id: "sys", role: "system" };
    expect(service(tracker).listUpcomingDeadlines(system, { today: TODAY })).toHaveLength(1);
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

describe("DeadlineTracker — what counts as an independent source", () => {
  it("still refuses to let the agent confirm its own arithmetic", () => {
    const tracker = new DeadlineTracker();
    // The agent calculating the same date ten times is one source.
    for (let i = 0; i < 10; i++) {
      tracker.record({ matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "agent" });
    }
    expect(tracker.status("m-1", "speedy_trial").state).toBe("unconfirmed");
  });

  it("does not let one person confirm their own entry by recording it twice", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedBy: "a1" });
    // Recording it twice isn't checking it twice.
    expect(tracker.status("m-1", "arraignment").state).toBe("unconfirmed");
  });

  it("counts two different people as two independent checks", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedBy: "a2" });
    // This is the case the old source-type-only model refused to count,
    // leaving a genuinely double-checked date reading "unverified" forever.
    expect(tracker.status("m-1", "arraignment").state).toBe("confirmed");
  });

  it("reports a conflict when two different people disagree", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m-1", type: "arraignment", date: "2026-08-06", source: "human", recordedBy: "a2" });
    expect(tracker.status("m-1", "arraignment").state).toBe("conflict");
  });

  it("keeps agent + one person confirming, exactly as before", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "agent" });
    tracker.record({ matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "human", recordedBy: "a1" });
    expect(tracker.status("m-1", "speedy_trial").state).toBe("confirmed");
  });

  it("treats the calendar system as one source however often it syncs", () => {
    const tracker = new DeadlineTracker();
    for (let i = 0; i < 5; i++) {
      tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "calendar_system" });
    }
    expect(tracker.status("m-1", "other").state).toBe("unconfirmed");
  });

  it("does not retroactively confirm old unattributed entries", () => {
    // Records written before `recordedBy` existed collapse to a single
    // identity — safer to leave them unverified than to invent a second
    // check that never happened.
    const tracker = DeadlineTracker.fromSnapshot([
      { matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedAt: "2026-01-01T00:00:00Z", note: undefined, recordedBy: undefined },
      { matterId: "m-1", type: "arraignment", date: "2026-08-01", source: "human", recordedAt: "2026-01-02T00:00:00Z", note: undefined, recordedBy: undefined },
    ]);
    expect(tracker.status("m-1", "arraignment").state).toBe("unconfirmed");
  });

  it("lists the independent sources seen so far", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "agent" });
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "human", recordedBy: "a1" });
    expect(tracker.independentSources("m-1", "other").sort()).toEqual(["agent", "human:a1"]);
  });
});

describe("ReviewGateService.deadlineVerificationHint", () => {
  function service(tracker: DeadlineTracker) {
    return new ReviewGateService(new WorkProductStore(), tracker);
  }

  it("says nothing is recorded yet", () => {
    expect(service(new DeadlineTracker()).deadlineVerificationHint(attorney, "m-1", "other")).toMatch(/nothing recorded/i);
  });

  it("tells the person who recorded it that someone else must check", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "human", recordedBy: "a1" });
    expect(service(tracker).deadlineVerificationHint(attorney, "m-1", "other")).toMatch(/you recorded this.*second, independent check/is);
  });

  it("tells a different attorney that confirming it completes the check", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "human", recordedBy: "someone-else" });
    expect(service(tracker).deadlineVerificationHint(attorney, "m-1", "other")).toMatch(/confirming it yourself will complete/i);
  });

  it("names the disagreeing dates on a conflict and refuses to suggest picking one", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-01", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m-1", type: "other", date: "2026-08-06", source: "human", recordedBy: "a2" });
    const hint = service(tracker).deadlineVerificationHint(attorney, "m-1", "other");
    expect(hint).toContain("2026-08-01");
    expect(hint).toContain("2026-08-06");
    expect(hint).toMatch(/not resolved by picking one/i);
  });

  it("says an agent-only date needs a person or the calendar", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m-1", type: "speedy_trial", date: "2026-08-01", source: "agent" });
    expect(service(tracker).deadlineVerificationHint(attorney, "m-1", "speedy_trial")).toMatch(/agent only/i);
  });

  it("is attorney-only", () => {
    expect(() => service(new DeadlineTracker()).deadlineVerificationHint(paralegal, "m-1", "other")).toThrow(AccessDeniedError);
  });
});
