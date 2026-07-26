import { describe, expect, it } from "vitest";
import { AuditService } from "../src/review-ui/audit-service.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

describe("AuditService (attorney-only surface)", () => {
  it("denies non-attorney actors, including plain reads", () => {
    const audit = new AuditService(new AuditLog());
    expect(() => audit.list(paralegal)).toThrow(AccessDeniedError);
  });

  it("lists all entries unredacted for an attorney", () => {
    const auditLog = new AuditLog();
    auditLog.append({ actor: paralegal, matterId: "m1", action: "access_granted", detail: "category=case_file reason=ok" });
    const audit = new AuditService(auditLog);
    const entries = audit.list(attorney);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("access_granted");
    expect(entries[0]?.detail).toBe("category=case_file reason=ok");
  });

  it("filters by matterId when provided", () => {
    const auditLog = new AuditLog();
    auditLog.append({ actor: paralegal, matterId: "m1", action: "access_granted", detail: undefined });
    auditLog.append({ actor: paralegal, matterId: "m2", action: "access_granted", detail: undefined });
    const audit = new AuditService(auditLog);
    const entries = audit.list(attorney, { matterId: "m1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matterId).toBe("m1");
  });
});
