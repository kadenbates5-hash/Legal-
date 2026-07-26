import { describe, expect, it } from "vitest";
import { InvoiceStore, InvoicingError } from "../src/core/invoicing.js";
import { InvoicingService } from "../src/review-ui/invoicing-service.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { ManualPaymentProcessor } from "../src/integrations/payment-processor.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function draftWithOneLine() {
  const store = new InvoiceStore();
  const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
  store.addLineItem(invoice.id, { description: "Drafting", source: "time", quantityMilli: 2_500, unitAmountCents: 300_00 });
  return { store, invoice };
}

describe("InvoiceStore", () => {
  it("computes a line total from thousandths of an hour without float drift", () => {
    const { store, invoice } = draftWithOneLine();
    // 2.5h * $300.00 = $750.00
    expect(store.subtotal(invoice.id)).toBe(750_00);
  });

  it("numbers invoices sequentially", () => {
    const store = new InvoiceStore();
    expect(store.createDraft({ matterId: "m-1", issuedBy: "a1" }).number).toBe("INV-00001");
    expect(store.createDraft({ matterId: "m-2", issuedBy: "a1" }).number).toBe("INV-00002");
  });

  it("locks line items once sent — a sent invoice can't be quietly edited", () => {
    const { store, invoice } = draftWithOneLine();
    store.send(invoice.id);
    expect(() =>
      store.addLineItem(invoice.id, { description: "Sneaky", source: "flat", quantityMilli: 1000, unitAmountCents: 100 }),
    ).toThrow(/can't be edited/i);
    expect(() => store.removeLineItem(invoice.id, invoice.lineItems[0]!.id)).toThrow(/locked/i);
  });

  it("refuses to send an empty invoice", () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    expect(() => store.send(invoice.id)).toThrow(/no line items/i);
  });

  it("refuses payment before the invoice is sent", () => {
    const { store, invoice } = draftWithOneLine();
    expect(() =>
      store.recordPayment({ invoiceId: invoice.id, amountCents: 100, method: "check", recordedBy: "a1" }),
    ).toThrow(/send the invoice/i);
  });

  it("moves through partially_paid to paid, and refuses overpayment", () => {
    const { store, invoice } = draftWithOneLine();
    store.send(invoice.id);

    store.recordPayment({ invoiceId: invoice.id, amountCents: 250_00, method: "check", recordedBy: "a1" });
    expect(store.get(invoice.id)!.status).toBe("partially_paid");
    expect(store.totals(invoice.id).balanceCents).toBe(500_00);

    expect(() =>
      store.recordPayment({ invoiceId: invoice.id, amountCents: 500_01, method: "check", recordedBy: "a1" }),
    ).toThrow(/exceeds/i);

    store.recordPayment({ invoiceId: invoice.id, amountCents: 500_00, method: "check", recordedBy: "a1" });
    expect(store.get(invoice.id)!.status).toBe("paid");
    expect(store.totals(invoice.id).balanceCents).toBe(0);
  });

  it("voids an unpaid invoice but refuses to void one with payments against it", () => {
    const { store, invoice } = draftWithOneLine();
    store.send(invoice.id);
    store.recordPayment({ invoiceId: invoice.id, amountCents: 10_00, method: "check", recordedBy: "a1" });
    expect(() => store.void(invoice.id, "mistake")).toThrow(/refund/i);

    const clean = draftWithOneLine();
    clean.store.send(clean.invoice.id);
    expect(clean.store.void(clean.invoice.id, "duplicate").status).toBe("void");
  });

  it("refuses payment on a voided invoice", () => {
    const { store, invoice } = draftWithOneLine();
    store.send(invoice.id);
    store.void(invoice.id, "duplicate");
    expect(() =>
      store.recordPayment({ invoiceId: invoice.id, amountCents: 100, method: "check", recordedBy: "a1" }),
    ).toThrow(/voided/i);
  });

  it("rejects fractional or non-positive money", () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    expect(() =>
      store.addLineItem(invoice.id, { description: "x", source: "flat", quantityMilli: 1000, unitAmountCents: 10.5 }),
    ).toThrow(/integer/i);
    expect(() =>
      store.addLineItem(invoice.id, { description: "x", source: "flat", quantityMilli: 1000, unitAmountCents: 0 }),
    ).toThrow(/positive/i);
  });

  it("round-trips through a snapshot, preserving totals and the numbering sequence", () => {
    const { store, invoice } = draftWithOneLine();
    store.send(invoice.id);
    store.recordPayment({ invoiceId: invoice.id, amountCents: 100_00, method: "check", recordedBy: "a1" });

    const restored = InvoiceStore.fromSnapshot(store.toSnapshot());
    expect(restored.totals(invoice.id)).toEqual({ subtotalCents: 750_00, paidCents: 100_00, balanceCents: 650_00 });
    expect(restored.createDraft({ matterId: "m-9", issuedBy: "a1" }).number).toBe("INV-00002");
    // Rules survive the reload.
    expect(() =>
      restored.addLineItem(invoice.id, { description: "x", source: "flat", quantityMilli: 1000, unitAmountCents: 100 }),
    ).toThrow(InvoicingError);
  });
});

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");
  const trust = new TrustLedger();
  const billingHours = new BillingHoursStore();
  const store = new InvoiceStore();
  const service = new InvoicingService({
    store,
    accessControl,
    auditLog,
    trust,
    billingHours,
    processor: new ManualPaymentProcessor(),
  });
  return { service, store, trust, billingHours, auditLog };
}

describe("InvoicingService", () => {
  it("lets a paralegal build a draft but not send it", () => {
    const { service } = makeService();
    const draft = service.createDraft(paralegal, "m-1", {});
    service.addLineItem(paralegal, "m-1", draft.id, {
      description: "Research",
      source: "time",
      quantityMilli: 1_000,
      unitAmountCents: 250_00,
    });
    expect(() => service.send(paralegal, "m-1", draft.id)).toThrow(AccessDeniedError);
    expect(service.send(attorney, "m-1", draft.id).status).toBe("sent");
  });

  it("scopes invoices to the paralegal's own matter", () => {
    const { service } = makeService();
    expect(() => service.listForMatter(paralegal, "m-other")).toThrow(AccessDeniedError);
  });

  it("pulls logged billable hours onto a draft at a chosen rate", () => {
    const { service, billingHours } = makeService();
    billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-28", hours: 1.5, description: "Review" });
    billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-29", hours: 2, description: "Drafting" });
    const draft = service.createDraft(attorney, "m-1", {});
    const withTime = service.addTimeFromBillingHours(attorney, "m-1", draft.id, 200_00);
    expect(withTime.lineItems).toHaveLength(2);
    // (1.5 + 2) * $200 = $700
    expect(withTime.totals.subtotalCents).toBe(700_00);
  });

  it("applies trust funds to an invoice, writing both records", () => {
    const { service, trust, auditLog } = makeService();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 1000_00, description: "Retainer", recordedBy: "a1" });

    const draft = service.createDraft(attorney, "m-1", {});
    service.addLineItem(attorney, "m-1", draft.id, {
      description: "Fees",
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: 400_00,
    });
    service.send(attorney, "m-1", draft.id);

    const paid = service.payFromTrust(attorney, "m-1", draft.id, 400_00);
    expect(paid.status).toBe("paid");
    // The trust side moved too, by exactly the same amount.
    expect(trust.balanceForMatter("m-1")).toBe(600_00);
    expect(trust.listForMatter("m-1").some((e) => e.type === "earned_fee_transfer")).toBe(true);
    expect(auditLog.read("attorney").some((e) => e.action === "invoice_paid_from_trust")).toBe(true);
  });

  it("records nothing at all when the client lacks the trust funds", () => {
    const { service, trust, store } = makeService();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 100_00, description: "Retainer", recordedBy: "a1" });

    const draft = service.createDraft(attorney, "m-1", {});
    service.addLineItem(attorney, "m-1", draft.id, {
      description: "Fees",
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: 500_00,
    });
    service.send(attorney, "m-1", draft.id);

    expect(() => service.payFromTrust(attorney, "m-1", draft.id, 500_00)).toThrow(/overdraw/i);
    // Neither side recorded anything — the two can't disagree about whether money moved.
    expect(trust.balanceForMatter("m-1")).toBe(100_00);
    expect(store.totals(draft.id).paidCents).toBe(0);
  });

  it("keeps applying trust funds attorney-only", () => {
    const { service, trust } = makeService();
    trust.record({ matterId: "m-1", type: "deposit", amountCents: 1000_00, description: "R", recordedBy: "a1" });
    const draft = service.createDraft(attorney, "m-1", {});
    service.addLineItem(attorney, "m-1", draft.id, { description: "F", source: "flat", quantityMilli: 1000, unitAmountCents: 100_00 });
    service.send(attorney, "m-1", draft.id);
    expect(() => service.payFromTrust(paralegal, "m-1", draft.id, 100_00)).toThrow(AccessDeniedError);
  });

  it("routes trust applications away from the plain payment path, so the ledger can't be bypassed", () => {
    const { service } = makeService();
    const draft = service.createDraft(attorney, "m-1", {});
    service.addLineItem(attorney, "m-1", draft.id, { description: "F", source: "flat", quantityMilli: 1000, unitAmountCents: 100_00 });
    service.send(attorney, "m-1", draft.id);
    expect(() =>
      service.recordPayment(attorney, "m-1", draft.id, { amountCents: 100_00, method: "trust_application" }),
    ).toThrow(/payFromTrust/);
  });

  it("reports that no processor can charge, rather than failing mysteriously later", () => {
    const { service } = makeService();
    expect(service.processorInfo(attorney)).toEqual({ name: "manual", canCharge: false });
  });

  it("surfaces a clear error if a charge is attempted with no processor configured", async () => {
    const { service } = makeService();
    const draft = service.createDraft(attorney, "m-1", {});
    service.addLineItem(attorney, "m-1", draft.id, { description: "F", source: "flat", quantityMilli: 1000, unitAmountCents: 100_00 });
    service.send(attorney, "m-1", draft.id);
    await expect(service.chargePayment(attorney, "m-1", draft.id, { amountCents: 100_00 })).rejects.toThrow(
      /no payment processor is configured/i,
    );
  });
});
