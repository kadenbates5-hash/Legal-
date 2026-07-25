import { describe, expect, it } from "vitest";
import { BillingHoursService } from "../src/review-ui/billing-hours-service.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeService() {
  const accessControl = new AccessControl(new AuditLog());
  accessControl.assignParalegal("p1", "m1");
  return { accessControl, service: new BillingHoursService({ accessControl, store: new BillingHoursStore() }) };
}

describe("BillingHoursService", () => {
  it("denies receptionists entirely", () => {
    const { service } = makeService();
    expect(() => service.listMyHours(receptionist)).toThrow(AccessDeniedError);
  });

  it("lets a paralegal log hours on their assigned matter", () => {
    const { service } = makeService();
    const entry = service.logHours(paralegal, "m1", { date: "2026-07-28", hours: 2, description: "Discovery review" });
    expect(entry.actorId).toBe("p1");
  });

  it("denies a paralegal logging hours on a matter they're not assigned to", () => {
    const { service } = makeService();
    expect(() => service.logHours(paralegal, "m2", { date: "2026-07-28", hours: 1, description: "x" })).toThrow(AccessDeniedError);
  });

  it("lets an attorney log/list hours on any matter", () => {
    const { service } = makeService();
    service.logHours(attorney, "m999", { date: "2026-07-28", hours: 1, description: "Client call" });
    expect(service.listMatterHours(attorney, "m999")).toHaveLength(1);
  });

  it("lists an actor's own hours across matters via listMyHours", () => {
    const { service } = makeService();
    service.logHours(paralegal, "m1", { date: "2026-07-28", hours: 1, description: "a" });
    expect(service.listMyHours(paralegal)).toHaveLength(1);
  });

  it("deletes an entry within an authorized matter", () => {
    const { service } = makeService();
    const entry = service.logHours(paralegal, "m1", { date: "2026-07-28", hours: 1, description: "a" });
    service.deleteEntry(paralegal, "m1", entry.id);
    expect(service.listMatterHours(paralegal, "m1")).toHaveLength(0);
  });
});
