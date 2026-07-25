import { describe, expect, it } from "vitest";
import { StaffScheduleService } from "../src/review-ui/staff-schedule-service.js";
import { StaffScheduleStore } from "../src/core/staff-schedule.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };
const system: Actor = { id: "system", role: "system" };

describe("StaffScheduleService", () => {
  it("denies the system credential", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    expect(() => service.listForDate(system, "2026-07-28")).toThrow(AccessDeniedError);
  });

  it("lets anyone set their own entry", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    const entry = service.setEntry(paralegal, "p1", "2026-07-28", "remote");
    expect(entry.status).toBe("remote");
  });

  it("denies a non-attorney from setting someone else's entry", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    expect(() => service.setEntry(paralegal, "r1", "2026-07-28", "in_office")).toThrow(AccessDeniedError);
  });

  it("lets an attorney set anyone's entry", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    const entry = service.setEntry(attorney, "r1", "2026-07-28", "out");
    expect(entry.actorId).toBe("r1");
  });

  it("lets any human read anyone's schedule", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    service.setEntry(attorney, "a1", "2026-07-28", "in_office");
    const entries = service.listForActor(receptionist, "a1");
    expect(entries).toHaveLength(1);
  });

  it("denies a non-attorney from removing someone else's entry, but allows removing their own", () => {
    const service = new StaffScheduleService(new StaffScheduleStore());
    service.setEntry(paralegal, "p1", "2026-07-28", "remote");
    expect(() => service.removeEntry(receptionist, "p1", "2026-07-28")).toThrow(AccessDeniedError);
    service.removeEntry(paralegal, "p1", "2026-07-28");
    expect(service.listForActor(paralegal, "p1")).toHaveLength(0);
  });
});
