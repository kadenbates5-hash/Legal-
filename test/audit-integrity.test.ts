import { describe, expect, it } from "vitest";
import { AuditLog, auditValue, diffFields, type AuditEntry } from "../src/core/audit.js";
import { AuditService } from "../src/review-ui/audit-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function logWith(count: number): AuditLog {
  const log = new AuditLog();
  for (let i = 0; i < count; i++) {
    log.append({ actor: attorney, matterId: "m-1", action: `action_${i}`, detail: `detail ${i}` });
  }
  return log;
}

describe("AuditLog — hash chain", () => {
  it("chains every entry to the one before it", () => {
    const log = logWith(3);
    const entries = log.toSnapshot();
    expect(entries[0]!.prevHash).toBe("");
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.hash);
    for (const e of entries) expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies an untouched log, including across a snapshot round trip", () => {
    const log = logWith(5);
    expect(log.verifyIntegrity()).toMatchObject({ ok: true, entriesChecked: 5, unchainedEntries: 0 });
    const restored = AuditLog.fromSnapshot(JSON.parse(JSON.stringify(log.toSnapshot())));
    expect(restored.verifyIntegrity().ok).toBe(true);
  });

  it("detects an altered entry and names the sequence", () => {
    const snapshot = logWith(5).toSnapshot();
    // Someone edits the persisted state file to soften what an entry says.
    snapshot[2] = { ...snapshot[2]!, detail: "nothing happened here" };
    const report = AuditLog.fromSnapshot(snapshot).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.brokenAtSequence).toBe(2);
    expect(report.reason).toMatch(/altered/i);
  });

  it("detects a deleted entry", () => {
    const snapshot = logWith(5).toSnapshot();
    snapshot.splice(2, 1); // remove the third entry entirely
    const report = AuditLog.fromSnapshot(snapshot).verifyIntegrity();
    expect(report.ok).toBe(false);
    // The gap shows up at the entry that used to follow it.
    expect(report.brokenAtSequence).toBe(3);
  });

  it("detects a forged entry spliced into the middle", () => {
    const snapshot = logWith(5).toSnapshot();
    const forged: AuditEntry = {
      sequence: 2,
      timestamp: new Date().toISOString(),
      actor: attorney,
      matterId: "m-1",
      action: "approval_that_never_happened",
      detail: undefined,
      prevHash: snapshot[1]!.hash!,
      hash: "0".repeat(64),
    };
    snapshot.splice(2, 0, forged);
    const report = AuditLog.fromSnapshot(snapshot).verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.brokenAtSequence).toBe(2);
  });

  it("detects reordering", () => {
    const snapshot = logWith(5).toSnapshot();
    [snapshot[1], snapshot[2]] = [snapshot[2]!, snapshot[1]!];
    expect(AuditLog.fromSnapshot(snapshot).verifyIntegrity().ok).toBe(false);
  });

  it("catches a changed actor — the field that says who did it", () => {
    const snapshot = logWith(3).toSnapshot();
    snapshot[1] = { ...snapshot[1]!, actor: { id: "someone-else", role: "paralegal" } };
    expect(AuditLog.fromSnapshot(snapshot).verifyIntegrity()).toMatchObject({ ok: false, brokenAtSequence: 1 });
  });

  it("catches a changed before/after value on an edit", () => {
    const log = new AuditLog();
    log.append({
      actor: attorney,
      matterId: "m-1",
      action: "matter_record_updated",
      detail: undefined,
      changes: [{ field: "adverseParties", from: "Acme Inc.", to: "" }],
    });
    const snapshot = log.toSnapshot();
    snapshot[0] = { ...snapshot[0]!, changes: [{ field: "adverseParties", from: "", to: "" }] };
    expect(AuditLog.fromSnapshot(snapshot).verifyIntegrity().ok).toBe(false);
  });

  it("keeps verifying as new entries are appended to a restored log", () => {
    const restored = AuditLog.fromSnapshot(logWith(3).toSnapshot());
    restored.append({ actor: attorney, matterId: "m-2", action: "later_action", detail: undefined });
    expect(restored.verifyIntegrity()).toMatchObject({ ok: true, entriesChecked: 4 });
  });

  it("treats pre-chaining entries as unverifiable rather than broken", () => {
    // A snapshot written before hashing existed has no hash/prevHash.
    const legacy: AuditEntry[] = [
      { sequence: 0, timestamp: "2026-01-01T00:00:00.000Z", actor: attorney, matterId: "m-1", action: "old", detail: undefined },
      { sequence: 1, timestamp: "2026-01-02T00:00:00.000Z", actor: attorney, matterId: "m-1", action: "older", detail: undefined },
    ];
    const log = AuditLog.fromSnapshot(legacy);
    expect(log.verifyIntegrity()).toMatchObject({ ok: true, unchainedEntries: 2 });

    // New entries chain from scratch and verify normally.
    log.append({ actor: attorney, matterId: "m-1", action: "new", detail: undefined });
    const report = log.verifyIntegrity();
    expect(report.ok).toBe(true);
    expect(report.unchainedEntries).toBe(2);
  });

  it("has no method that rewrites or removes an entry", () => {
    const log = logWith(1);
    for (const forbidden of ["update", "delete", "remove", "edit", "clear", "truncate"]) {
      expect((log as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
    // And a returned entry can't be mutated into something else.
    const entry = log.read("attorney")[0]!;
    expect(() => {
      (entry as { action: string }).action = "tampered";
    }).toThrow();
  });
});

describe("AuditLog — filtering", () => {
  function mixed(): AuditLog {
    const log = new AuditLog();
    log.append({ actor: attorney, matterId: "m-1", action: "document_uploaded", detail: "a" });
    log.append({ actor: paralegal, matterId: "m-1", action: "document_deleted", detail: "b" });
    log.append({ actor: paralegal, matterId: "m-2", action: "invoice_sent", detail: "c" });
    return log;
  }

  it("filters by matter, actor and action independently and together", () => {
    const log = mixed();
    expect(log.read("attorney", { matterId: "m-1" })).toHaveLength(2);
    expect(log.read("attorney", { actorId: "p1" })).toHaveLength(2);
    expect(log.read("attorney", { action: "document" })).toHaveLength(2);
    expect(log.read("attorney", { actorId: "p1", action: "document" })).toHaveLength(1);
  });

  it("matches an action case-insensitively, as a substring", () => {
    expect(mixed().read("attorney", { action: "INVOICE" })).toHaveLength(1);
  });

  it("bounds by calendar date inclusively", () => {
    const log = new AuditLog();
    log.append({ actor: attorney, matterId: undefined, action: "x", detail: undefined });
    const today = new Date().toISOString().slice(0, 10);
    expect(log.read("attorney", { from: today, to: today })).toHaveLength(1);
    expect(log.read("attorney", { from: "2099-01-01" })).toHaveLength(0);
    expect(log.read("attorney", { to: "2000-01-01" })).toHaveLength(0);
  });

  it("redacts action, detail and changes for a non-counsel reader, but keeps the chain visible", () => {
    const log = new AuditLog();
    log.append({
      actor: attorney,
      matterId: "m-1",
      action: "matter_record_updated",
      detail: "privileged",
      changes: [{ field: "clients", from: "A", to: "B" }],
    });
    const [entry] = log.read("system_admin_no_content");
    expect(entry!.action).toBe("[redacted]");
    expect(entry!.detail).toBeUndefined();
    expect(entry!.changes).toBeUndefined();
    // Timestamps, sequence and hashes stay — that's what ops needs.
    expect(entry!.hash).toBeDefined();
  });
});

describe("diffFields / auditValue", () => {
  it("records only the fields that actually changed", () => {
    const changes = diffFields({ a: "1", b: "2" }, { a: "1", b: "3" }, ["a", "b"]);
    expect(changes).toEqual([{ field: "b", from: "2", to: "3" }]);
  });

  it("marks a newly set field and a cleared one distinctly", () => {
    expect(diffFields(undefined, { a: "new" }, ["a"])).toEqual([{ field: "a", from: undefined, to: "new" }]);
    expect(diffFields({ a: "old" }, { a: undefined } as Record<string, unknown>, ["a"])).toEqual([
      { field: "a", from: "old", to: undefined },
    ]);
  });

  it("renders arrays and objects readably, and truncates something enormous", () => {
    expect(auditValue(["a", "b"])).toBe("a, b");
    expect(auditValue({ x: 1 })).toBe('{"x":1}');
    expect(auditValue(true)).toBe("true");
    expect(auditValue(0)).toBe("0");
    expect(auditValue(null)).toBeUndefined();
    expect(auditValue("x".repeat(900))!.length).toBeLessThanOrEqual(501);
  });
});

describe("AuditService", () => {
  it("keeps reading and verifying attorney-only", async () => {
    const service = new AuditService(logWith(2));
    expect(() => service.list(paralegal)).toThrow(AccessDeniedError);
    await expect(service.verifyIntegrity(paralegal)).rejects.toThrow(AccessDeniedError);
    expect(service.list(attorney)).toHaveLength(2);
    expect((await service.verifyIntegrity(attorney)).ok).toBe(true);
  });

  it("reports a broken chain to the attorney rather than hiding or repairing it", async () => {
    const snapshot = logWith(4).toSnapshot();
    snapshot[1] = { ...snapshot[1]!, action: "quietly_changed" };
    const service = new AuditService(AuditLog.fromSnapshot(snapshot));
    const report = await service.verifyIntegrity(attorney);
    expect(report.ok).toBe(false);
    expect(report.brokenAtSequence).toBe(1);
    // Verifying again gives the same answer — nothing was "fixed" in passing.
    expect((await service.verifyIntegrity(attorney)).brokenAtSequence).toBe(1);
  });
});
