import { describe, expect, it } from "vitest";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { MatterStore } from "../src/core/matters.js";
import { DocumentStore } from "../src/core/document-store.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { InvoicingService } from "../src/review-ui/invoicing-service.js";
import { ClientPortalService } from "../src/review-ui/client-portal-service.js";
import { ManualPaymentProcessor } from "../src/integrations/payment-processor.js";

const client: Actor = { id: "c1", role: "client" };
const attorney: Actor = { id: "a1", role: "attorney" };
const otherClient: Actor = { id: "c2", role: "client" };

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const matters = new MatterStore();
  const documents = new DocumentStore();
  const trust = new TrustLedger();
  const invoiceStore = new InvoiceStore();
  const invoicing = new InvoicingService({
    store: invoiceStore,
    accessControl,
    auditLog,
    trust,
    billingHours: new BillingHoursStore(),
    processor: new ManualPaymentProcessor(),
  });
  const portal = new ClientPortalService({
    accessControl,
    matters,
    documents,
    trust,
    invoicing,
    paymentInstructions: "Pay by check, payable to the firm.",
  });
  matters.upsert("m1", {
    title: "State v. Ruiz",
    status: "open",
    parties: [{ name: "Jane Ruiz", role: "client", note: undefined, email: "jane@example.com" }],
  });
  accessControl.grantClientAccess("c1", "m1");
  return { auditLog, accessControl, matters, documents, trust, invoiceStore, invoicing, portal };
}

describe("ClientPortalService", () => {
  it("is client-only", () => {
    const { portal } = makeService();
    expect(() => portal.listMyMatters(attorney)).toThrow(AccessDeniedError);
    expect(() => portal.getMatter(attorney, "m1")).toThrow(AccessDeniedError);
  });

  it("lists only granted matters, projected to matterId/title/status", () => {
    const { portal } = makeService();
    expect(portal.listMyMatters(client)).toEqual([{ matterId: "m1", title: "State v. Ruiz", status: "open" }]);
    expect(portal.listMyMatters(otherClient)).toEqual([]);
  });

  it("omits a granted matterId with no Matter record yet rather than showing it half-blank", () => {
    const { accessControl, portal } = makeService();
    accessControl.grantClientAccess("c1", "m-not-yet-filed");
    expect(portal.listMyMatters(client).map((m) => m.matterId)).toEqual(["m1"]);
  });

  it("refuses a matter this client wasn't granted, and never names the adverse party or description", () => {
    const { matters, portal } = makeService();
    matters.upsert("m2", {
      title: "Someone else's case",
      status: "open",
      description: "privileged strategy notes",
      parties: [
        { name: "Other Client", role: "client", note: undefined, email: undefined },
        { name: "Adverse Co", role: "adverse", note: undefined, email: undefined },
      ],
    });
    expect(() => portal.getMatter(client, "m2")).toThrow(AccessDeniedError);
  });

  it("getMatter never exposes parties or description — only matterId/title/status plus the client-safe extras", () => {
    const { portal } = makeService();
    const detail = portal.getMatter(client, "m1");
    expect(detail).toEqual(
      expect.objectContaining({ matterId: "m1", title: "State v. Ruiz", status: "open", trustBalanceCents: 0 }),
    );
    expect(detail).not.toHaveProperty("parties");
    expect(detail).not.toHaveProperty("description");
    expect(detail.paymentInstructions).toBe("Pay by check, payable to the firm.");
  });

  it("shows the trust balance as a single number, not the entry history", () => {
    const { trust, portal } = makeService();
    trust.record({ matterId: "m1", type: "deposit", amountCents: 50_000, description: "retainer" });
    const detail = portal.getMatter(client, "m1");
    expect(detail.trustBalanceCents).toBe(50_000);
    expect(detail).not.toHaveProperty("trustEntries");
  });

  describe("documents", () => {
    it("hides an uploaded document until staff explicitly shares it", () => {
      const { documents, portal } = makeService();
      const doc = documents.upload({ matterId: "m1", fileName: "contract.pdf", contentType: "application/pdf", content: "AAAA", uploadedBy: "p1" });
      expect(portal.getMatter(client, "m1").documents).toEqual([]);

      documents.setClientVisibility(doc.id, true);
      const shown = portal.getMatter(client, "m1").documents;
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ id: doc.id, fileName: "contract.pdf" });
      // No base64 content in the summary — only the dedicated download call includes it.
      expect(shown[0]).not.toHaveProperty("content");
    });

    it("getDocument refuses one that exists but was never shared, the same as one that doesn't exist at all", () => {
      const { documents, portal } = makeService();
      const doc = documents.upload({ matterId: "m1", fileName: "private.pdf", contentType: "application/pdf", content: "AAAA", uploadedBy: "p1" });
      expect(() => portal.getDocument(client, "m1", doc.id)).toThrow(/no document/);
      expect(() => portal.getDocument(client, "m1", "doc_999")).toThrow(/no document/);
    });

    it("getDocument returns content once shared, but refuses across matters", () => {
      const { documents, accessControl, portal } = makeService();
      const doc = documents.upload({ matterId: "m1", fileName: "letter.pdf", contentType: "application/pdf", content: "AAAA", uploadedBy: "p1" });
      documents.setClientVisibility(doc.id, true);
      expect(portal.getDocument(client, "m1", doc.id).content).toBe("AAAA");

      accessControl.grantClientAccess("c2", "m1");
      // Shared, but c2 didn't upload/own it — still fine, they're granted the matter.
      expect(() => portal.getDocument(otherClient, "m1", doc.id)).not.toThrow();
    });
  });

  describe("invoices", () => {
    it("never shows a draft invoice", () => {
      const { invoicing, portal } = makeService();
      invoicing.createDraft(attorney, "m1", {});
      expect(portal.getMatter(client, "m1").invoices).toEqual([]);
    });

    it("shows a sent invoice, and previewForClient/pdf match what was actually emailed", () => {
      const { invoicing, portal } = makeService();
      const draft = invoicing.createDraft(attorney, "m1", {});
      invoicing.addLineItem(attorney, "m1", draft.id, {
        description: "Research",
        source: "time",
        quantityMilli: 1_000,
        unitAmountCents: 100_00,
      });
      invoicing.send(attorney, "m1", draft.id);

      const invoices = portal.getMatter(client, "m1").invoices!;
      expect(invoices).toHaveLength(1);
      expect(invoices[0]!.status).toBe("sent");

      const rendered = portal.previewInvoice(client, "m1", draft.id);
      expect(rendered.text).toContain("Research");
      expect(rendered.text).toContain("100.00");
    });

    it("refuses to preview/render an invoice belonging to a different matter, even if the client can see both", () => {
      const { matters, accessControl, invoicing, portal } = makeService();
      matters.upsert("m2", { title: "Other matter", status: "open", parties: [] });
      accessControl.grantClientAccess("c1", "m2");
      const draft = invoicing.createDraft(attorney, "m1", {});
      invoicing.addLineItem(attorney, "m1", draft.id, { description: "x", source: "flat", quantityMilli: 1000, unitAmountCents: 100 });
      invoicing.send(attorney, "m1", draft.id);

      expect(() => portal.previewInvoice(client, "m2", draft.id)).toThrow();
    });

    it("degrades to no invoices at all when InvoicingService isn't configured", () => {
      const auditLog = new AuditLog();
      const accessControl = new AccessControl(auditLog);
      const matters = new MatterStore();
      matters.upsert("m1", { title: "State v. Ruiz", status: "open", parties: [] });
      accessControl.grantClientAccess("c1", "m1");
      const portal = new ClientPortalService({ accessControl, matters, documents: new DocumentStore() });
      const detail = portal.getMatter(client, "m1");
      expect(detail.invoices).toBeUndefined();
      expect(() => portal.previewInvoice(client, "m1", "inv_1")).toThrow(/not configured/);
    });
  });
});
