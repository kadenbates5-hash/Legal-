import { describe, expect, it } from "vitest";
import { DeadlineTracker } from "../src/core/deadline.js";

describe("DeadlineTracker — never single-sourced", () => {
  it("stays unconfirmed after a single agent calculation, no matter how many times recorded", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    expect(tracker.isConfirmed("m1", "speedy_trial")).toBe(false);
    expect(tracker.status("m1", "speedy_trial").state).toBe("unconfirmed");
  });

  it("confirms once a second, independent source agrees on the same date", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    const status = tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" });
    expect(status.state).toBe("confirmed");
    expect(tracker.isConfirmed("m1", "speedy_trial")).toBe(true);
  });

  it("confirms via a calendar-system source just as well as a human one", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "arraignment", date: "2026-08-15", source: "agent" });
    const status = tracker.record({ matterId: "m1", type: "arraignment", date: "2026-08-15", source: "calendar_system" });
    expect(status.state).toBe("confirmed");
  });

  it("flags a conflict — never silently picks a winner — when independent sources disagree", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "bail_hearing", date: "2026-07-30", source: "agent" });
    const status = tracker.record({ matterId: "m1", type: "bail_hearing", date: "2026-08-01", source: "human" });
    expect(status.state).toBe("conflict");
    expect(tracker.isConfirmed("m1", "bail_hearing")).toBe(false);
  });

  it("lists conflicts across matters for a dashboard to surface immediately", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-02", source: "human" });
    tracker.record({ matterId: "m2", type: "arraignment", date: "2026-08-01", source: "agent" });
    tracker.record({ matterId: "m2", type: "arraignment", date: "2026-08-01", source: "human" });

    const conflicts = tracker.listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.matterId).toBe("m1");
  });

  it("keeps matters and deadline types independent of one another", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" });
    // A different type on the same matter is a separate, still-unconfirmed deadline.
    expect(tracker.isConfirmed("m1", "arraignment")).toBe(false);
    // A different matter with the same type is also separate.
    expect(tracker.isConfirmed("m2", "speedy_trial")).toBe(false);
  });

  it("round-trips through a snapshot, preserving confirmation and conflict state", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" });
    tracker.record({ matterId: "m2", type: "bail_hearing", date: "2026-07-30", source: "agent" });
    tracker.record({ matterId: "m2", type: "bail_hearing", date: "2026-08-01", source: "human" });

    const restored = DeadlineTracker.fromSnapshot(tracker.toSnapshot());
    expect(restored.isConfirmed("m1", "speedy_trial")).toBe(true);
    expect(restored.status("m2", "bail_hearing").state).toBe("conflict");
  });
});
