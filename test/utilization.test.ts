import { describe, expect, it } from "vitest";
import { UtilizationTracker } from "../src/core/utilization.js";

describe("AI utilization tracking", () => {
  it("logs per-task entries and computes revision rate", () => {
    const tracker = new UtilizationTracker();
    const e1 = tracker.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "engagement letter" });
    tracker.finish(e1.id, "completed");
    const e2 = tracker.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "discovery request" });
    tracker.finish(e2.id, "revised_after_review");

    expect(tracker.all()).toHaveLength(2);
    expect(tracker.revisionRate("paralegal")).toBe(0.5);
  });

  it("keeps utilization entries separate from any billing concept", () => {
    const tracker = new UtilizationTracker();
    const entry = tracker.start({ matterId: "m1", agentRole: "receptionist", taskType: "intake", description: "new client intake" });
    expect(entry).not.toHaveProperty("billableRate");
    expect(entry).not.toHaveProperty("invoiceLineId");
  });
});
