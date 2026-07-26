import { describe, expect, it } from "vitest";
import { InvoiceStore } from "../src/core/invoicing.js";
import { PdfLibInvoicePdfRenderer, invoicePdfFilename } from "../src/integrations/invoice-pdf.js";
import { PdfParseTextExtractor } from "../src/integrations/pdf-text.js";
import type { RenderInvoiceParams } from "../src/core/invoice-render.js";

const renderer = new PdfLibInvoicePdfRenderer();

/** Reads the PDF back with this project's own extractor, so assertions are on the real output. */
async function textOf(pdf: Buffer): Promise<string> {
  const { text } = await new PdfParseTextExtractor().extractText(pdf);
  // The extractor emits page separators; collapse whitespace so wrapped
  // lines and column gaps don't defeat a substring check.
  return text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, " ").replace(/\s+/g, " ");
}

function paramsFor(store: InvoiceStore, invoiceId: string, overrides: Partial<RenderInvoiceParams> = {}): RenderInvoiceParams {
  const invoice = store.get(invoiceId)!;
  return {
    invoice,
    totals: store.totals(invoiceId),
    payments: store.paymentsFor(invoiceId),
    firm: {
      name: "Reyes & Okafor LLP",
      addressLines: ["120 Court Street", "Brooklyn, NY 11201"],
      email: "billing@reyesokafor.example",
      paymentInstructions: "Payable within 30 days of the invoice date.",
    },
    matterTitle: "State v. Ruiz",
    clientName: "Maria Ruiz",
    timekeeperNames: { p1: "J. Okafor", a1: "L. Reyes" },
    ...overrides,
  };
}

function invoiceWithWork() {
  const store = new InvoiceStore();
  const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1", dueDate: "2026-08-30" });
  store.addLineItem(invoice.id, {
    description: "Reviewed discovery production and indexed exhibits",
    source: "time",
    quantityMilli: 3_500,
    unitAmountCents: 250_00,
    workedOn: "2026-07-20",
    timekeeperId: "p1",
  });
  store.addLineItem(invoice.id, {
    description: "Drafted motion to suppress",
    source: "time",
    quantityMilli: 2_000,
    unitAmountCents: 400_00,
    workedOn: "2026-07-22",
    timekeeperId: "a1",
  });
  store.addLineItem(invoice.id, {
    description: "Court filing fee",
    source: "expense",
    quantityMilli: 1_000,
    unitAmountCents: 75_00,
  });
  return { store, invoice };
}

describe("PdfLibInvoicePdfRenderer", () => {
  it("produces a real PDF", async () => {
    const { store, invoice } = invoiceWithWork();
    const pdf = await renderer.render(paramsFor(store, invoice.id));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it("carries the full itemisation into the document", async () => {
    const { store, invoice } = invoiceWithWork();
    const text = await textOf(await renderer.render(paramsFor(store, invoice.id)));

    expect(text).toContain("Reyes & Okafor LLP");
    expect(text).toContain("Brooklyn, NY 11201");
    expect(text).toContain(`INVOICE ${invoice.number}`);
    expect(text).toContain("Maria Ruiz");
    expect(text).toContain("State v. Ruiz");
    expect(text).toContain("2026-08-30");

    // Every element a client needs to check a line: date, who, what, how
    // long, at what rate, for how much.
    expect(text).toContain("2026-07-20");
    expect(text).toContain("J. Okafor");
    expect(text).toContain("Reviewed discovery production and indexed exhibits");
    expect(text).toContain("3.50");
    expect(text).toContain("$250.00");
    expect(text).toContain("$875.00");

    expect(text).toContain("PROFESSIONAL SERVICES");
    expect(text).toContain("EXPENSES AND DISBURSEMENTS");
    expect(text).not.toContain("FIXED FEES");

    expect(text).toContain("Balance due");
    expect(text).toContain("$1,750.00");
    expect(text).toContain("Payable within 30 days");
  });

  it("shows payments applied and the reduced balance", async () => {
    const { store, invoice } = invoiceWithWork();
    store.send(invoice.id);
    store.recordPayment({ invoiceId: invoice.id, amountCents: 750_00, method: "check", reference: "1041", recordedBy: "a1" });
    const text = await textOf(await renderer.render(paramsFor(store, invoice.id)));
    expect(text).toContain("Check (1041)");
    expect(text).toContain("-$750.00");
    expect(text).toContain("$1,000.00");
  });

  it("marks a void invoice as void", async () => {
    const { store, invoice } = invoiceWithWork();
    store.void(invoice.id, "billed to the wrong matter");
    const text = await textOf(await renderer.render(paramsFor(store, invoice.id)));
    expect(text).toContain("VOID");
    expect(text).toContain("billed to the wrong matter");
  });

  it("paginates a long invoice and numbers the pages", async () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    for (let i = 0; i < 60; i++) {
      store.addLineItem(invoice.id, {
        description: `Task number ${i} — reviewed correspondence and updated the case chronology`,
        source: "time",
        quantityMilli: 1_000,
        unitAmountCents: 250_00,
        workedOn: "2026-07-20",
        timekeeperId: "p1",
      });
    }
    const text = await textOf(await renderer.render(paramsFor(store, invoice.id)));
    expect(text).toContain("Page 1 of");
    // The last line must still be present — nothing silently truncated.
    expect(text).toContain("Task number 59");
    // 60 hours at $250.
    expect(text).toContain("$15,000.00");
  });

  it("wraps a description too long for its column instead of clipping it", async () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    const long =
      "Attended the suppression hearing, examined the arresting officer regarding the traffic stop, " +
      "argued the absence of reasonable suspicion, and conferred with the client afterwards about the " +
      "implications for the plea negotiations scheduled for the following week";
    store.addLineItem(invoice.id, {
      description: long,
      source: "time",
      quantityMilli: 4_000,
      unitAmountCents: 400_00,
      workedOn: "2026-07-24",
      timekeeperId: "a1",
    });
    const text = await textOf(await renderer.render(paramsFor(store, invoice.id)));
    // Both ends of the description survive, so nothing fell off the column.
    expect(text).toContain("Attended the suppression hearing");
    expect(text).toContain("scheduled for the following week");
  });

  it("does not throw on characters the standard PDF fonts can't encode", async () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    store.addLineItem(invoice.id, {
      // Smart quotes, an em dash, and a script Helvetica has no glyphs for.
      description: "Reviewed the client\u2019s \u201Cnotes\u201D \u2014 including 日本語 material",
      source: "time",
      quantityMilli: 1_000,
      unitAmountCents: 100_00,
      workedOn: "2026-07-20",
    });
    const pdf = await renderer.render(paramsFor(store, invoice.id, { clientName: "María Ruiz-Peña", matterTitle: "Ruiz — appeal" }));
    const text = await textOf(pdf);
    expect(text).toContain("Reviewed the client's");
    expect(text).toContain('"notes"');
  });

  it("handles an invoice with a single flat fee and no client or matter title", async () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-9", issuedBy: "a1" });
    store.addLineItem(invoice.id, {
      description: "Flat fee — misdemeanour representation",
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: 2_500_00,
    });
    const text = await textOf(
      await renderer.render({
        invoice: store.get(invoice.id)!,
        totals: store.totals(invoice.id),
        payments: [],
        firm: { name: "Solo Practice" },
      }),
    );
    expect(text).toContain("FIXED FEES");
    expect(text).toContain("$2,500.00");
    // A flat fee has no date or timekeeper, so those column headers are
    // omitted rather than printed over blank space on a client's bill.
    expect(text).not.toContain("Date");
    expect(text).not.toContain("By ");
    // Falls back to the matter id when there's no caption.
    expect(text).toContain("m-9");
  });
});

describe("invoicePdfFilename", () => {
  it("builds a readable, filesystem-safe name", () => {
    expect(invoicePdfFilename("INV-00001", "State v. Ruiz")).toBe("INV-00001 State v. Ruiz.pdf");
  });

  it("strips characters that would break a path or a header", () => {
    expect(invoicePdfFilename("INV-00002", 'A/B "C" \\D\r\nE')).toBe("INV-00002 A B C D E.pdf");
  });

  it("falls back to the invoice number when the title contributes nothing", () => {
    expect(invoicePdfFilename("INV-00003", "///")).toBe("INV-00003.pdf");
  });
});
