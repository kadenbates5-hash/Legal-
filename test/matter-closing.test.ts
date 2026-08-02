import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { MatterStore, addYears } from "../src/core/matters.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { MattersService, MatterClosingError } from "../src/review-ui/matters-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function setup(options: { retentionYears?: number } = {}) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");
  const store = new MatterStore();
  store.upsert("m-1", { title: "State v. Ruiz" });
  const trust = new TrustLedger();
  const invoices = new InvoiceStore();
  const workProducts = new WorkProductStore();
  const service = new MattersService({
    store,
    checker: new ConflictChecker(store),
    accessControl,
    auditLog,
    trust,
    invoices,
    workProducts,
    ...(options.retentionYears !== undefined ? { retentionYears: options.retentionYears } : {}),
  });
  return { auditLog, store, trust, invoices, workProducts, service };
}

describe("addYears", () => {
  it("adds whole years", () => {
    expect(addYears("2026-07-26", 7)).toBe("2033-07-26");
  });

  it("lands 29 February on the 28th rather than rolling into March", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
  });
});

describe("MattersService.close — client funds", () => {
  it("refuses to close a matter still holding money in trust", () => {
    const { service, trust } = setup();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 250_00, description: "Retainer", recordedBy: "a1" });

    expect(() => service.close(attorney, "m-1", { closingNote: "Case concluded" })).toThrow(MatterClosingError);
    expect(() => service.close(attorney, "m-1", { closingNote: "Case concluded" })).toThrow(/\$250\.00/);
    // And the matter really is still open — no partial close.
    expect(service.get(attorney, "m-1").status).toBe("open");
  });

  it("closes once the funds are returned", () => {
    const { service, trust } = setup();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 250_00, description: "Retainer", recordedBy: "a1" });
    trust.record({ matterId: "m-1", type: "refund", amountCents: 250_00, description: "Returned to client", recordedBy: "a1" });

    const { matter } = service.close(attorney, "m-1", { closingNote: "Case concluded, retainer refunded" });
    expect(matter.status).toBe("closed");
    expect(matter.closedAt).toBeDefined();
  });

  it("explains what to do rather than just refusing", () => {
    const { service, trust } = setup();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 100_00, description: "Retainer", recordedBy: "a1" });
    expect(() => service.close(attorney, "m-1", { closingNote: "done" })).toThrow(/refund it or apply it to an invoice/i);
  });
});

describe("MattersService.close — warnings", () => {
  it("warns about unpaid invoices but does not block", () => {
    const { service, invoices } = setup();
    const invoice = invoices.createDraft({ matterId: "m-1", issuedBy: "a1" });
    invoices.addLineItem(invoice.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 500_00 });
    invoices.send(invoice.id);

    const { matter, warnings } = service.close(attorney, "m-1", { closingNote: "Concluded; still pursuing the fee" });
    expect(matter.status).toBe("closed");
    expect(warnings.join(" ")).toMatch(/1 unpaid invoice\(s\) totalling \$500\.00/);
  });

  it("does not warn about an invoice that was paid or voided", () => {
    const { service, invoices } = setup();
    const paid = invoices.createDraft({ matterId: "m-1", issuedBy: "a1" });
    invoices.addLineItem(paid.id, { description: "Fee", source: "flat", quantityMilli: 1_000, unitAmountCents: 100_00 });
    invoices.send(paid.id);
    invoices.recordPayment({ invoiceId: paid.id, amountCents: 100_00, method: "check", recordedBy: "a1" });

    expect(service.close(attorney, "m-1", { closingNote: "Concluded" }).warnings).toEqual([]);
  });

  it("warns about work product that never finished review", () => {
    const { service, workProducts, auditLog } = setup();
    workProducts.register(new WorkProduct({ id: "wp_1", matterId: "m-1", kind: "motion", content: "..." }, auditLog));

    const { warnings } = service.close(attorney, "m-1", { closingNote: "Concluded" });
    expect(warnings.join(" ")).toMatch(/1 work product\(s\) never finished review/);
  });

  it("closes cleanly with no warnings when nothing is outstanding", () => {
    const { service } = setup();
    expect(service.close(attorney, "m-1", { closingNote: "Concluded" }).warnings).toEqual([]);
  });
});

describe("MattersService.close — record keeping", () => {
  it("stamps a retention date from the firm's period", () => {
    const { service } = setup({ retentionYears: 7 });
    const { matter } = service.close(attorney, "m-1", { closingNote: "Concluded" });
    const expected = addYears(new Date().toISOString().slice(0, 10), 7);
    expect(matter.retentionUntil).toBe(expected);
  });

  it("records no retention date when the firm hasn't configured a period", () => {
    const { service } = setup();
    expect(service.close(attorney, "m-1", { closingNote: "Concluded" }).matter.retentionUntil).toBeUndefined();
  });

  it("requires a closing note recording the disposition", () => {
    const { service } = setup();
    expect(() => service.close(attorney, "m-1", { closingNote: "   " })).toThrow(/needs a note/i);
  });

  it("keeps the note on the record", () => {
    const { service } = setup();
    const { matter } = service.close(attorney, "m-1", { closingNote: "Charges dismissed at the suppression hearing" });
    expect(matter.closingNote).toBe("Charges dismissed at the suppression hearing");
  });

  it("refuses to close an already-closed matter", () => {
    const { service } = setup();
    service.close(attorney, "m-1", { closingNote: "Concluded" });
    expect(() => service.close(attorney, "m-1", { closingNote: "Again" })).toThrow(/already closed/i);
  });

  it("is attorney-only, for closing and reopening alike", () => {
    const { service } = setup();
    expect(() => service.close(paralegal, "m-1", { closingNote: "Concluded" })).toThrow(AccessDeniedError);
    service.close(attorney, "m-1", { closingNote: "Concluded" });
    expect(() => service.reopen(paralegal, "m-1", "more work")).toThrow(AccessDeniedError);
  });

  it("audits the close and the reopen", () => {
    const { service, auditLog } = setup({ retentionYears: 6 });
    service.close(attorney, "m-1", { closingNote: "Concluded" });
    service.reopen(attorney, "m-1", "client returned on a related charge");

    const actions = auditLog.read("attorney").map((e) => e.action);
    expect(actions).toContain("matter_closed");
    expect(actions).toContain("matter_reopened");
    expect(auditLog.read("attorney").find((e) => e.action === "matter_reopened")!.detail).toContain("client returned");
  });
});

describe("MattersService.reopen", () => {
  it("clears the retention date, so a live matter never shows as due for review", () => {
    const { service } = setup({ retentionYears: 1 });
    service.close(attorney, "m-1", { closingNote: "Concluded" });
    const reopened = service.reopen(attorney, "m-1", "appeal filed");
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.retentionUntil).toBeUndefined();
  });

  it("requires a reason", () => {
    const { service } = setup();
    service.close(attorney, "m-1", { closingNote: "Concluded" });
    expect(() => service.reopen(attorney, "m-1", " ")).toThrow(/needs a reason/i);
  });
});

describe("MattersService.listRetentionDue", () => {
  it("lists closed matters whose retention has run out, oldest first", () => {
    const { service, store } = setup();
    store.upsert("m-2", { title: "Old matter", status: "closed", retentionUntil: "2020-01-01" });
    store.upsert("m-3", { title: "Older matter", status: "closed", retentionUntil: "2015-01-01" });
    store.upsert("m-4", { title: "Not yet", status: "closed", retentionUntil: "2099-01-01" });

    const due = service.listRetentionDue(attorney, new Date("2026-07-26T00:00:00Z"));
    expect(due.map((m) => m.matterId)).toEqual(["m-3", "m-2"]);
  });

  it("never includes an open matter, even one carrying an old date", () => {
    const { service, store } = setup();
    store.upsert("m-2", { title: "Reopened", status: "closed", retentionUntil: "2020-01-01" });
    store.upsert("m-2", { status: "open" });
    expect(service.listRetentionDue(attorney)).toEqual([]);
  });

  it("is a list and nothing more — no method here deletes anything", () => {
    const { service, store } = setup();
    store.upsert("m-2", { title: "Old", status: "closed", retentionUntil: "2020-01-01" });
    service.listRetentionDue(attorney);
    // Destroying a client file has notice obligations; software must not
    // do it on a timer.
    expect(store.get("m-2")).toBeDefined();
    for (const forbidden of ["destroy", "purge", "deleteMatter", "shred"]) {
      expect((service as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it("is attorney-only", () => {
    const { service } = setup();
    expect(() => service.listRetentionDue(paralegal)).toThrow(AccessDeniedError);
  });
});

describe("MattersService.clientEmailFor", () => {
  const system: Actor = { id: "sys", role: "system" };

  it("returns the client party's email for the system credential", () => {
    const { service, store } = setup();
    store.upsert("m-1", {
      title: "State v. Ruiz",
      parties: [{ name: "Carlos Ruiz", role: "client", note: undefined, email: "carlos@example.com" }],
    });
    expect(service.clientEmailFor(system, "m-1")).toBe("carlos@example.com");
  });

  it("returns undefined when no client party has an email on record", () => {
    const { service } = setup();
    expect(service.clientEmailFor(system, "m-1")).toBeUndefined();
  });

  it("returns undefined for a matter with no record at all, rather than throwing", () => {
    const { service } = setup();
    expect(service.clientEmailFor(system, "no-such-matter")).toBeUndefined();
  });

  it("denies every role but system, including attorney and paralegal", () => {
    const { service } = setup();
    expect(() => service.clientEmailFor(attorney, "m-1")).toThrow(AccessDeniedError);
    expect(() => service.clientEmailFor(paralegal, "m-1")).toThrow(AccessDeniedError);
  });
});
