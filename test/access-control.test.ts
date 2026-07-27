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

  it("denies staff and system actors by default (no scope modeled for them)", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "s1", role: "staff" }, matterId: "m1", category: "intake" }),
    ).toThrow(AccessDeniedError);
    expect(() =>
      ac.authorize({ actor: { id: "sys1", role: "system" }, matterId: "m1", category: "scheduling" }),
    ).toThrow(AccessDeniedError);
  });

  it("lets an assigned paralegal draft billing/time-entry narratives for their own matter", () => {
    const ac = new AccessControl(new AuditLog());
    ac.assignParalegal("p1", "m1");
    expect(() =>
      ac.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", category: "billing_internal" }),
    ).not.toThrow();
  });

  it("denies the receptionist billing_internal access even though it handles billing calls", () => {
    const ac = new AccessControl(new AuditLog());
    expect(() =>
      ac.authorize({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", category: "billing_internal" }),
    ).toThrow(AccessDeniedError);
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

  describe("getParalegalAssignment", () => {
    it("returns undefined when there is no assignment", () => {
      const ac = new AccessControl(new AuditLog());
      expect(ac.getParalegalAssignment("p1")).toBeUndefined();
    });

    it("returns the current assignment, including the high-sensitivity grant", () => {
      const ac = new AccessControl(new AuditLog());
      ac.assignParalegal("p1", "m1", { highSensitivityGranted: true });
      expect(ac.getParalegalAssignment("p1")).toEqual({ actorId: "p1", matterId: "m1", highSensitivityGranted: true });
    });

    it("returns undefined again after revocation", () => {
      const ac = new AccessControl(new AuditLog());
      ac.assignParalegal("p1", "m1");
      ac.revokeParalegalAssignment("p1");
      expect(ac.getParalegalAssignment("p1")).toBeUndefined();
    });
  });

  describe("snapshot round-trip", () => {
    it("preserves paralegal assignments, including the high-sensitivity grant", () => {
      const auditLog = new AuditLog();
      const ac = new AccessControl(auditLog);
      ac.assignParalegal("p1", "m1", { highSensitivityGranted: true });
      ac.assignParalegal("p2", "m2");

      const restored = AccessControl.fromSnapshot(auditLog, ac.toSnapshot());
      expect(restored.getParalegalAssignment("p1")).toEqual({ actorId: "p1", matterId: "m1", highSensitivityGranted: true });
      expect(restored.getParalegalAssignment("p2")).toEqual({ actorId: "p2", matterId: "m2", highSensitivityGranted: false });

      // Restored instance still enforces the rules, not just replayed data.
      expect(() =>
        restored.authorize({ actor: { id: "p1", role: "paralegal" }, matterId: "m2", category: "case_file" }),
      ).toThrow(AccessDeniedError);
    });

    it("round-trips an empty assignment set", () => {
      const auditLog = new AuditLog();
      const ac = new AccessControl(auditLog);
      const restored = AccessControl.fromSnapshot(auditLog, ac.toSnapshot());
      expect(restored.getParalegalAssignment("p1")).toBeUndefined();
    });
  });

  describe("client portal access", () => {
    it("denies a client with no grant", () => {
      const ac = new AccessControl(new AuditLog());
      expect(() =>
        ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m1", category: "client_portal" }),
      ).toThrow(AccessDeniedError);
    });

    it("grants exactly the matters a client was given, and nothing else", () => {
      const ac = new AccessControl(new AuditLog());
      ac.grantClientAccess("c1", "m1");
      expect(() =>
        ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m1", category: "client_portal" }),
      ).not.toThrow();
      expect(() =>
        ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m2", category: "client_portal" }),
      ).toThrow(AccessDeniedError);
    });

    it("is additive — granting a second matter doesn't revoke the first (unlike a paralegal assignment)", () => {
      const ac = new AccessControl(new AuditLog());
      ac.grantClientAccess("c1", "m1");
      ac.grantClientAccess("c1", "m2");
      expect(ac.getClientMatterIds("c1").sort()).toEqual(["m1", "m2"]);
      expect(() =>
        ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m1", category: "client_portal" }),
      ).not.toThrow();
      expect(() =>
        ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m2", category: "client_portal" }),
      ).not.toThrow();
    });

    it("revoking one matter leaves the others intact", () => {
      const ac = new AccessControl(new AuditLog());
      ac.grantClientAccess("c1", "m1");
      ac.grantClientAccess("c1", "m2");
      ac.revokeClientAccess("c1", "m1");
      expect(ac.getClientMatterIds("c1")).toEqual(["m2"]);
    });

    it("confines a client to the client_portal category even on a matter it's granted", () => {
      const ac = new AccessControl(new AuditLog());
      ac.grantClientAccess("c1", "m1");
      for (const category of ["case_file", "billing_internal", "high_sensitivity", "intake", "scheduling"] as const) {
        expect(() => ac.authorize({ actor: { id: "c1", role: "client" }, matterId: "m1", category })).toThrow(
          AccessDeniedError,
        );
      }
    });

    it("lists every grant, flattened, for the Accounts panel", () => {
      const ac = new AccessControl(new AuditLog());
      ac.grantClientAccess("c1", "m1");
      ac.grantClientAccess("c1", "m2");
      ac.grantClientAccess("c2", "m1");
      expect(ac.listClientAssignments().sort((a, b) => a.actorId.localeCompare(b.actorId) || a.matterId.localeCompare(b.matterId))).toEqual([
        { actorId: "c1", matterId: "m1" },
        { actorId: "c1", matterId: "m2" },
        { actorId: "c2", matterId: "m1" },
      ]);
    });

    it("round-trips client grants, and an old snapshot with none still loads", () => {
      const auditLog = new AuditLog();
      const ac = new AccessControl(auditLog);
      ac.assignParalegal("p1", "m1");
      ac.grantClientAccess("c1", "m1");
      ac.grantClientAccess("c1", "m2");

      const restored = AccessControl.fromSnapshot(auditLog, ac.toSnapshot(), ac.clientAccessSnapshot());
      expect(restored.getClientMatterIds("c1").sort()).toEqual(["m1", "m2"]);
      // Restored instance still enforces the rule, not just replayed data.
      expect(() =>
        restored.authorize({ actor: { id: "c1", role: "client" }, matterId: "m3", category: "client_portal" }),
      ).toThrow(AccessDeniedError);

      // A snapshot predating client accounts (no third argument at all).
      const legacyRestored = AccessControl.fromSnapshot(auditLog, ac.toSnapshot());
      expect(legacyRestored.getClientMatterIds("c1")).toEqual([]);
    });
  });
});
