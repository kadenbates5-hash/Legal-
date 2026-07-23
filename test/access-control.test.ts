import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError } from "../src/core/types.js";

describe("access control", () => {
  it("lets the receptionist read intake and scheduling fields", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "intake" }),
    ).not.toThrow();
    expect(() =>
      ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "scheduling" }),
    ).not.toThrow();
  });

  it("denies the receptionist any case-file access", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "case_file" }),
    ).toThrow(AccessDeniedError);
  });

  it("denies a paralegal with no assignment", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "case_file" }),
    ).toThrow(AccessDeniedError);
  });

  it("scopes a paralegal to only its assigned matter — no cross-matter visibility", () => {
    const ac = new AccessControl(new AuditLog());
    ac.assignParalegal("p1", "m1");
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "case_file" }),
    ).not.toThrow();
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m2", category: "case_file" }),
    ).toThrow(AccessDeniedError);
  });

  it("requires an explicit grant for the high-sensitivity tier beyond ordinary matter scoping", () => {
    const ac = new AccessControl(new AuditLog());
    ac.assignParalegal("p1", "m1");
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "high_sensitivity" }),
    ).toThrow(AccessDeniedError);

    ac.assignParalegal("p1", "m1", { highSensitivityGranted: true });
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "high_sensitivity" }),
    ).not.toThrow();
  });

  it("lets an attorney access anything", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "a1", role: "attorney" }, matterId: "m1", category: "high_sensitivity" }),
    ).not.toThrow();
  });

  it("logs both grants and denials to the audit trail", () => {
    const log = new AuditLog();
    const ac = new AccessControl(log);
    try {
      ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "case_file" });
    } catch {
      // expected
    }
    ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "intake" });
    const entries = log.read("attorney", { matterId: "m1" });
    expect(entries.some((e) => e.action === "access_denied")).toBe(true);
    expect(entries.some((e) => e.action === "access_granted")).toBe(true);
  });

  it("revoking a paralegal assignment removes access immediately", () => {
    const ac = new AccessControl(new AuditLog());
    ac.assignParalegal("p1", "m1");
    ac.revokeParalegalAssignment("p1");
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "case_file" }),
    ).toThrow(AccessDeniedError);
  });
});
