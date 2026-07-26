import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { DocumentStore } from "../src/core/document-store.js";
import { MatterStore } from "../src/core/matters.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import type { Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function entriesOf(log: AuditLog, action: string) {
  return log.read("attorney").filter((e) => e.action === action);
}

describe("audit coverage — matter record edits", () => {
  function setup() {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const store = new MatterStore();
    const service = new MattersService({
      store,
      accessControl,
      auditLog,
      checker: new ConflictChecker(store),
    });
    return { auditLog, service };
  }

  it("distinguishes creating a record from editing one", () => {
    const { auditLog, service } = setup();
    service.upsert(attorney, "m-1", { title: "State v. Ruiz" });
    service.upsert(attorney, "m-1", { title: "State v. Ruiz (appeal)" });
    expect(entriesOf(auditLog, "matter_record_created")).toHaveLength(1);
    expect(entriesOf(auditLog, "matter_record_updated")).toHaveLength(1);
  });

  it("records what changed, not merely that something did", () => {
    const { auditLog, service } = setup();
    service.upsert(attorney, "m-1", { title: "State v. Ruiz", status: "open" });
    service.upsert(attorney, "m-1", { title: "State v. Ruiz", status: "closed" });

    const changes = entriesOf(auditLog, "matter_record_updated")[0]!.changes!;
    expect(changes).toEqual([{ field: "status", from: "open", to: "closed" }]);
  });

  it("captures a removed adverse party — the edit that would weaken conflicts screening", () => {
    const { auditLog, service } = setup();
    service.upsert(attorney, "m-1", {
      parties: [
        { name: "Maria Ruiz", role: "client", note: undefined, email: undefined },
        { name: "Acme Inc.", role: "adverse", note: undefined, email: undefined },
      ],
    });
    // Someone quietly drops the adversary.
    service.upsert(attorney, "m-1", {
      parties: [{ name: "Maria Ruiz", role: "client", note: undefined, email: undefined }],
    });

    const changes = entriesOf(auditLog, "matter_record_updated")[0]!.changes!;
    expect(changes).toEqual([{ field: "adverseParties", from: "Acme Inc.", to: undefined }]);
  });

  it("records a changed client billing email", () => {
    const { auditLog, service } = setup();
    service.upsert(attorney, "m-1", {
      parties: [{ name: "Maria Ruiz", role: "client", note: undefined, email: "maria@example.com" }],
    });
    service.upsert(attorney, "m-1", {
      parties: [{ name: "Maria Ruiz", role: "client", note: undefined, email: "elsewhere@example.com" }],
    });
    expect(entriesOf(auditLog, "matter_record_updated")[0]!.changes).toEqual([
      { field: "clients", from: "Maria Ruiz <maria@example.com>", to: "Maria Ruiz <elsewhere@example.com>" },
    ]);
  });

  it("writes no change list when nothing actually changed", () => {
    const { auditLog, service } = setup();
    service.upsert(attorney, "m-1", { title: "State v. Ruiz" });
    service.upsert(attorney, "m-1", { title: "State v. Ruiz" });
    expect(entriesOf(auditLog, "matter_record_updated")[0]!.changes).toBeUndefined();
  });
});

describe("audit coverage — case documents", () => {
  function setup() {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    accessControl.assignParalegal("p1", "m-1");
    const service = new DocumentsService({ accessControl, store: new DocumentStore(), auditLog });
    return { auditLog, service };
  }

  it("records who put a file in the case file", () => {
    const { auditLog, service } = setup();
    service.upload(paralegal, "m-1", {
      fileName: "contract.pdf",
      contentType: "application/pdf",
      content: Buffer.from("hello").toString("base64"),
    });
    const entry = entriesOf(auditLog, "document_uploaded")[0]!;
    expect(entry.actor.id).toBe("p1");
    expect(entry.matterId).toBe("m-1");
    expect(entry.detail).toContain("name=contract.pdf");
    expect(entry.detail).toContain("bytes=5");
  });

  it("keeps what a deleted file was, since nothing else survives the deletion", () => {
    const { auditLog, service } = setup();
    const doc = service.upload(paralegal, "m-1", {
      fileName: "exhibit-a.pdf",
      contentType: "application/pdf",
      content: Buffer.from("x").toString("base64"),
    });
    service.delete(paralegal, "m-1", doc.id);

    const entry = entriesOf(auditLog, "document_deleted")[0]!;
    expect(entry.detail).toContain("name=exhibit-a.pdf");
    expect(entry.detail).toContain("uploadedBy=p1");
  });

  it("logs nothing for an upload that was refused", () => {
    const { auditLog, service } = setup();
    expect(() =>
      service.upload(paralegal, "m-2", { fileName: "x.pdf", contentType: "application/pdf", content: "eA==" }),
    ).toThrow();
    expect(entriesOf(auditLog, "document_uploaded")).toHaveLength(0);
    // The denial itself is still on the record, via AccessControl.
    expect(auditLog.read("attorney").some((e) => /denied/i.test(e.action))).toBe(true);
  });
});

describe("audit coverage — account management", () => {
  function setup() {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const auth = new AuthService();
    const service = new AccountsService(auth, accessControl, undefined, auditLog);
    return { auditLog, auth, service };
  }

  it("records account creation with the role granted, and never the password", () => {
    const { auditLog, service } = setup();
    service.create(attorney, { username: "newpara", password: "correct-horse", role: "paralegal" });
    const entry = entriesOf(auditLog, "account_created")[0]!;
    expect(entry.detail).toContain("username=newpara");
    expect(entry.detail).toContain("role=paralegal");
    expect(JSON.stringify(entry)).not.toContain("correct-horse");
  });

  it("records disabling, re-enabling and password resets", () => {
    const { auditLog, service } = setup();
    // Keep one attorney enabled so disabling is allowed.
    service.create(attorney, { username: "keeper", password: "correct-horse", role: "attorney" });
    const target = service.create(attorney, { username: "temp", password: "correct-horse", role: "paralegal" });
    service.disable(attorney, target.id);
    service.enable(attorney, target.id);
    service.resetPassword(attorney, target.id, "brand-new-password");

    for (const action of ["account_disabled", "account_enabled", "account_password_reset"]) {
      expect(entriesOf(auditLog, action)).toHaveLength(1);
    }
    expect(JSON.stringify(auditLog.read("attorney"))).not.toContain("brand-new-password");
  });

  it("files a matter assignment under that matter, and notes what it replaced", () => {
    const { auditLog, service } = setup();
    const para = service.create(attorney, { username: "para", password: "correct-horse", role: "paralegal" });
    service.assignMatter(attorney, para.id, "m-1");
    service.assignMatter(attorney, para.id, "m-2");
    service.unassignMatter(attorney, para.id);

    const assigns = entriesOf(auditLog, "matter_assigned");
    expect(assigns.map((e) => e.matterId)).toEqual(["m-1", "m-2"]);
    expect(assigns[1]!.detail).toContain("replacedMatter=m-1");
    expect(entriesOf(auditLog, "matter_unassigned")[0]!.matterId).toBe("m-2");
  });

  it("leaves the chain intact across all of it", () => {
    const { auditLog, service } = setup();
    service.create(attorney, { username: "a", password: "correct-horse", role: "paralegal" });
    service.create(attorney, { username: "b", password: "correct-horse", role: "paralegal" });
    expect(auditLog.verifyIntegrity().ok).toBe(true);
  });
});
