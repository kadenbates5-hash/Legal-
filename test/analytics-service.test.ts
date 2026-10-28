import { describe, expect, it, vi } from "vitest";
import { AnalyticsService } from "../src/review-ui/analytics-service.js";
import { MatterStore } from "../src/core/matters.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import { AuthService } from "../src/core/auth.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeAnalytics() {
  const matters = new MatterStore();
  const invoices = new InvoiceStore();
  const billingHours = new BillingHoursStore();
  const utilization = new UtilizationTracker();
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1", displayName: "Ada Attorney" });
  auth.createUser({ username: "attorney2", password: "correct-horse", role: "attorney", actorId: "a2", displayName: "Bo Attorney" });
  const analytics = new AnalyticsService({ matters, invoices, billingHours, utilization, auth });
  return { matters, invoices, billingHours, utilization, auth, analytics };
}

describe("AnalyticsService — access control", () => {
  it("every method is attorney-only, including plain reads", () => {
    const { analytics } = makeAnalytics();
    expect(() => analytics.caseloadByAttorney(paralegal)).toThrow(AccessDeniedError);
    expect(() => analytics.matterStatusCounts(paralegal)).toThrow(AccessDeniedError);
    expect(() => analytics.invoiceAging(paralegal)).toThrow(AccessDeniedError);
    expect(() => analytics.utilizationTrend(paralegal)).toThrow(AccessDeniedError);
    expect(() => analytics.billableHoursTrend(paralegal)).toThrow(AccessDeniedError);
  });
});

describe("AnalyticsService.caseloadByAttorney", () => {
  it("counts open and closed matters per responsible attorney", () => {
    const { matters, analytics } = makeAnalytics();
    matters.upsert("m1", { title: "A", responsibleAttorneyId: "a1", status: "open" });
    matters.upsert("m2", { title: "B", responsibleAttorneyId: "a1", status: "open" });
    matters.upsert("m3", { title: "C", responsibleAttorneyId: "a1", status: "closed" });
    matters.upsert("m4", { title: "D", responsibleAttorneyId: "a2", status: "open" });

    const result = analytics.caseloadByAttorney(attorney);
    const ada = result.find((r) => r.actorId === "a1")!;
    const bo = result.find((r) => r.actorId === "a2")!;
    expect(ada).toMatchObject({ displayName: "Ada Attorney", openMatters: 2, closedMatters: 1 });
    expect(bo).toMatchObject({ displayName: "Bo Attorney", openMatters: 1, closedMatters: 0 });
  });

  it("groups matters with no responsible attorney under an explicit unassigned bucket", () => {
    const { matters, analytics } = makeAnalytics();
    matters.upsert("m1", { title: "Unowned", status: "open" });
    const result = analytics.caseloadByAttorney(attorney);
    expect(result.find((r) => r.actorId === "(unassigned)")?.openMatters).toBe(1);
  });

  it("sorts most-open-matters first", () => {
    const { matters, analytics } = makeAnalytics();
    matters.upsert("m1", { title: "A", responsibleAttorneyId: "a2", status: "open" });
    matters.upsert("m2", { title: "B", responsibleAttorneyId: "a1", status: "open" });
    matters.upsert("m3", { title: "C", responsibleAttorneyId: "a1", status: "open" });
    const result = analytics.caseloadByAttorney(attorney);
    expect(result[0]!.actorId).toBe("a1");
  });
});

describe("AnalyticsService.matterStatusCounts", () => {
  it("counts matters by status firm-wide", () => {
    const { matters, analytics } = makeAnalytics();
    matters.upsert("m1", { title: "A", status: "open" });
    matters.upsert("m2", { title: "B", status: "open" });
    matters.upsert("m3", { title: "C", status: "closed" });
    matters.upsert("m4", { title: "D", status: "prospective" });
    expect(analytics.matterStatusCounts(attorney)).toEqual({ prospective: 1, open: 2, closed: 1 });
  });
});

describe("AnalyticsService.invoiceAging", () => {
  it("buckets an unpaid sent invoice by how overdue it is", () => {
    const { invoices, analytics } = makeAnalytics();
    const asOf = new Date("2026-06-15T00:00:00Z");
    const current = invoices.createDraft({ matterId: "m1", issuedBy: "a1", dueDate: "2026-07-01" }); // not yet due
    invoices.addLineItem(current.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 100_00 });
    invoices.send(current.id);

    const overdue45 = invoices.createDraft({ matterId: "m2", issuedBy: "a1", dueDate: "2026-05-01" }); // 45 days overdue
    invoices.addLineItem(overdue45.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 200_00 });
    invoices.send(overdue45.id);

    const aging = analytics.invoiceAging(attorney, asOf);
    expect(aging.find((b) => b.bucket === "current")).toMatchObject({ count: 1, totalCents: 100_00 });
    expect(aging.find((b) => b.bucket === "31-60")).toMatchObject({ count: 1, totalCents: 200_00 });
    expect(aging.find((b) => b.bucket === "1-30")).toMatchObject({ count: 0, totalCents: 0 });
  });

  it("excludes a draft, a fully paid invoice, and a voided one", () => {
    const { invoices, analytics } = makeAnalytics();
    const draft = invoices.createDraft({ matterId: "m1", issuedBy: "a1" });
    invoices.addLineItem(draft.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 100_00 });

    const paid = invoices.createDraft({ matterId: "m2", issuedBy: "a1" });
    invoices.addLineItem(paid.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 50_00 });
    invoices.send(paid.id);
    invoices.recordPayment({ invoiceId: paid.id, amountCents: 50_00, method: "check", recordedBy: "a1" });

    const aging = analytics.invoiceAging(attorney);
    expect(aging.every((b) => b.count === 0)).toBe(true);
  });
});

describe("AnalyticsService.utilizationTrend", () => {
  it("sums finished AI-agent minutes per day and task type", () => {
    const { utilization, analytics } = makeAnalytics();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-10T09:00:00Z"));
      const entry1 = utilization.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "x" });
      vi.setSystemTime(new Date("2026-06-10T09:30:00Z")); // +30 min
      utilization.finish(entry1.id, "completed");

      const entry2 = utilization.start({ matterId: "m1", agentRole: "receptionist", taskType: "intake", description: "y" });
      vi.setSystemTime(new Date("2026-06-10T09:45:00Z")); // +15 min
      utilization.finish(entry2.id, "completed");

      // Still open — contributes nothing.
      utilization.start({ matterId: "m1", agentRole: "paralegal", taskType: "research", description: "z" });

      const trend = analytics.utilizationTrend(attorney, { now: new Date("2026-06-15T00:00:00Z") });
      expect(trend).toHaveLength(1);
      expect(trend[0]!.date).toBe("2026-06-10");
      expect(trend[0]!.minutesByTaskType.drafting).toBe(30);
      expect(trend[0]!.minutesByTaskType.intake).toBe(15);
      expect(trend[0]!.minutesByTaskType.research).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes entries outside the requested window", () => {
    const { utilization, analytics } = makeAnalytics();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T09:00:00Z"));
      const old = utilization.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "x" });
      vi.setSystemTime(new Date("2026-05-01T09:10:00Z"));
      utilization.finish(old.id, "completed");

      const trend = analytics.utilizationTrend(attorney, { withinDays: 7, now: new Date("2026-06-15T00:00:00Z") });
      expect(trend).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AnalyticsService.billableHoursTrend", () => {
  it("sums logged hours per day across matters", () => {
    const { billingHours, analytics } = makeAnalytics();
    billingHours.log({ matterId: "m1", actorId: "a1", date: "2026-06-10", hours: 2, description: "x" });
    billingHours.log({ matterId: "m2", actorId: "a2", date: "2026-06-10", hours: 1.5, description: "y" });
    billingHours.log({ matterId: "m1", actorId: "a1", date: "2026-06-11", hours: 3, description: "z" });

    const trend = analytics.billableHoursTrend(attorney, { now: new Date("2026-06-15T00:00:00Z") });
    expect(trend).toEqual([
      { date: "2026-06-10", hours: 3.5 },
      { date: "2026-06-11", hours: 3 },
    ]);
  });

  it("excludes entries outside the requested window", () => {
    const { billingHours, analytics } = makeAnalytics();
    billingHours.log({ matterId: "m1", actorId: "a1", date: "2026-01-01", hours: 2, description: "old" });
    const trend = analytics.billableHoursTrend(attorney, { withinDays: 7, now: new Date("2026-06-15T00:00:00Z") });
    expect(trend).toEqual([]);
  });
});
