import { describe, expect, it } from "vitest";
import { PayrollError, PayrollStore } from "../src/core/payroll.js";
import { PayrollService } from "../src/review-ui/payroll-service.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const otherParalegal: Actor = { id: "p2", role: "paralegal" };

describe("PayrollStore", () => {
  it("prices a shift at the rate in force on the day it was worked", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 30_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    store.setRate({ actorId: "p1", hourlyCents: 35_00, effectiveFrom: "2026-07-01", setBy: "a1" });

    store.recordHours({ actorId: "p1", date: "2026-06-30", hoursMilli: 8_000, description: "Before raise", recordedBy: "p1" });
    store.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 8_000, description: "After raise", recordedBy: "p1" });

    const summary = store.summarize("2026-06-01", "2026-07-31");
    // 8h @ $30 + 8h @ $35 = $240 + $280
    expect(summary.lines[0]!.grossPayCents).toBe(520_00);
  });

  it("does not retroactively restate an already-paid period when a raise is added later", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 30_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    store.recordHours({ actorId: "p1", date: "2026-06-15", hoursMilli: 10_000, description: "Work", recordedBy: "p1" });
    const before = store.summarize("2026-06-01", "2026-06-30").totalGrossPayCents;

    store.setRate({ actorId: "p1", hourlyCents: 50_00, effectiveFrom: "2026-07-01", setBy: "a1" });
    expect(store.summarize("2026-06-01", "2026-06-30").totalGrossPayCents).toBe(before);
  });

  it("flags a shift with no rate on record instead of silently pricing it at zero", () => {
    const store = new PayrollStore();
    store.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 8_000, description: "Unrated", recordedBy: "p1" });
    const summary = store.summarize("2026-07-01", "2026-07-31");
    expect(summary.incomplete).toBe(true);
    expect(summary.lines[0]!.datesMissingRate).toEqual(["2026-07-02"]);
    expect(summary.lines[0]!.hoursMilli).toBe(8_000);
    expect(summary.lines[0]!.grossPayCents).toBe(0);
  });

  it("ignores a rate that only becomes effective after the shift", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 30_00, effectiveFrom: "2026-08-01", setBy: "a1" });
    store.recordHours({ actorId: "p1", date: "2026-07-15", hoursMilli: 1_000, description: "Earlier", recordedBy: "p1" });
    expect(store.summarize("2026-07-01", "2026-07-31").incomplete).toBe(true);
  });

  it("computes fractional hours exactly, without float multiplication of money", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 33_33, effectiveFrom: "2026-01-01", setBy: "a1" });
    store.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 7_500, description: "7.5h", recordedBy: "p1" });
    // 7.5 * 3333 = 24997.5 -> 24998 cents, rounded once.
    expect(store.summarize("2026-07-01", "2026-07-31").totalGrossPayCents).toBe(24_998);
  });

  it("totals several people separately", () => {
    const store = new PayrollStore();
    for (const id of ["p1", "p2"]) {
      store.setRate({ actorId: id, hourlyCents: 20_00, effectiveFrom: "2026-01-01", setBy: "a1" });
      store.recordHours({ actorId: id, date: "2026-07-02", hoursMilli: 5_000, description: "Work", recordedBy: "a1" });
    }
    const summary = store.summarize("2026-07-01", "2026-07-31");
    expect(summary.lines).toHaveLength(2);
    expect(summary.totalGrossPayCents).toBe(200_00);
  });

  it("excludes shifts outside the period", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 20_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    store.recordHours({ actorId: "p1", date: "2026-06-30", hoursMilli: 1_000, description: "Before", recordedBy: "p1" });
    store.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 1_000, description: "In", recordedBy: "p1" });
    expect(store.summarize("2026-07-01", "2026-07-31").totalGrossPayCents).toBe(20_00);
  });

  it("validates dates, rates and hours", () => {
    const store = new PayrollStore();
    expect(() => store.setRate({ actorId: "p1", hourlyCents: 1000, effectiveFrom: "07/01/2026", setBy: "a1" })).toThrow(PayrollError);
    expect(() => store.setRate({ actorId: "p1", hourlyCents: 10.5, effectiveFrom: "2026-01-01", setBy: "a1" })).toThrow(/integer/i);
    expect(() => store.recordHours({ actorId: "p1", date: "2026-01-01", hoursMilli: 0, description: "x", recordedBy: "a1" })).toThrow(/positive/i);
    expect(() => store.summarize("2026-08-01", "2026-07-01")).toThrow(/must not be after/i);
  });

  it("round-trips through a snapshot", () => {
    const store = new PayrollStore();
    store.setRate({ actorId: "p1", hourlyCents: 25_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    store.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 4_000, description: "Work", recordedBy: "p1" });
    const restored = PayrollStore.fromSnapshot(store.toSnapshot());
    expect(restored.summarize("2026-07-01", "2026-07-31").totalGrossPayCents).toBe(100_00);
  });
});

function makeService() {
  const auditLog = new AuditLog();
  return { auditLog, service: new PayrollService({ store: new PayrollStore(), auditLog }) };
}

describe("PayrollService — who may see what people are paid", () => {
  it("keeps setting a pay rate attorney-only", () => {
    const { service } = makeService();
    expect(() => service.setRate(paralegal, "p1", { hourlyCents: 100_00, effectiveFrom: "2026-01-01" })).toThrow(
      AccessDeniedError,
    );
    expect(service.setRate(attorney, "p1", { hourlyCents: 30_00, effectiveFrom: "2026-01-01" }).hourlyCents).toBe(30_00);
  });

  it("lets you see your own rate but not a colleague's", () => {
    const { service } = makeService();
    service.setRate(attorney, "p1", { hourlyCents: 30_00, effectiveFrom: "2026-01-01" });
    expect(service.listRates(paralegal, "p1")).toHaveLength(1);
    expect(() => service.listRates(otherParalegal, "p1")).toThrow(AccessDeniedError);
    // An attorney can see anyone's.
    expect(service.listRates(attorney, "p1")).toHaveLength(1);
  });

  it("lets you log your own hours, and an attorney log anyone's", () => {
    const { service } = makeService();
    expect(service.recordHours(paralegal, "p1", { date: "2026-07-02", hoursMilli: 8_000, description: "Work" }).actorId).toBe("p1");
    expect(() => service.recordHours(paralegal, "p2", { date: "2026-07-02", hoursMilli: 8_000, description: "x" })).toThrow(
      AccessDeniedError,
    );
    expect(service.recordHours(attorney, "p2", { date: "2026-07-02", hoursMilli: 8_000, description: "Work" }).actorId).toBe("p2");
  });

  it("keeps the firm-wide summary attorney-only and audits it", () => {
    const { service, auditLog } = makeService();
    expect(() => service.summarize(paralegal, "2026-07-01", "2026-07-31")).toThrow(AccessDeniedError);
    service.summarize(attorney, "2026-07-01", "2026-07-31");
    expect(auditLog.read("attorney").some((e) => e.action === "payroll_summary_run")).toBe(true);
  });

  it("will not delete another person's hours", () => {
    const { service } = makeService();
    const entry = service.recordHours(attorney, "p2", { date: "2026-07-02", hoursMilli: 1_000, description: "Work" });
    expect(() => service.deleteHours(paralegal, "p2", entry.id)).toThrow(AccessDeniedError);
    service.deleteHours(attorney, "p2", entry.id);
    expect(service.listHours(attorney, "p2")).toHaveLength(0);
  });
});
