import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/core/audit.js";

describe("audit log", () => {
  it("is append-only and sequences entries", () => {
    const log = new AuditLog();
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", action: "intake_started", detail: undefined });
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", action: "intake_finished", detail: undefined });
    expect(log.count()).toBe(2);
    const entries = log.read("attorney");
    expect(entries[0]!.sequence).toBe(0);
    expect(entries[1]!.sequence).toBe(1);
  });

  it("redacts privilege-sensitive content for non-counsel readers", () => {
    const log = new AuditLog();
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", action: "caller_stated_facts", detail: "confession-adjacent narrative" });
    const [entry] = log.read("system_admin_no_content");
    expect(entry!.action).toBe("[redacted]");
    expect(entry!.detail).toBeUndefined();
  });

  it("lets counsel read full content", () => {
    const log = new AuditLog();
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", action: "caller_stated_facts", detail: "confession-adjacent narrative" });
    const [entry] = log.read("attorney");
    expect(entry!.action).toBe("caller_stated_facts");
    expect(entry!.detail).toBe("confession-adjacent narrative");
  });

  it("filters by matter", () => {
    const log = new AuditLog();
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m1", action: "a", detail: undefined });
    log.append({ actor: { id: "r1", role: "receptionist" }, matterId: "m2", action: "b", detail: undefined });
    expect(log.read("attorney", { matterId: "m1" })).toHaveLength(1);
  });
});
