import { describe, expect, it } from "vitest";
import { InvoiceStore } from "../src/core/invoicing.js";
import { formatCents, formatQuantity, renderInvoice } from "../src/core/invoice-render.js";

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
    sourceEntryId: "hrs_1",
  });
  store.addLineItem(invoice.id, {
    description: "Drafted motion to suppress",
    source: "time",
    quantityMilli: 2_000,
    unitAmountCents: 400_00,
    workedOn: "2026-07-22",
    timekeeperId: "a1",
    sourceEntryId: "hrs_2",
  });
  store.addLineItem(invoice.id, {
    description: "Court filing fee",
    source: "expense",
    quantityMilli: 1_000,
    unitAmountCents: 75_00,
  });
  return { store, invoice };
}

function render(store: InvoiceStore, invoiceId: string) {
  const invoice = store.get(invoiceId)!;
  return renderInvoice({
    invoice,
    totals: store.totals(invoiceId),
    payments: store.paymentsFor(invoiceId),
    firm: { name: "Reyes & Okafor LLP", email: "billing@reyesokafor.example", paymentInstructions: "Payable within 30 days." },
    matterTitle: "State v. Ruiz",
    clientName: "Maria Ruiz",
    timekeeperNames: { p1: "J. Okafor", a1: "L. Reyes" },
  });
}

describe("renderInvoice — itemisation", () => {
  it("shows the date, timekeeper, task, hours and rate for every time line", () => {
    const { store, invoice } = invoiceWithWork();
    const { text } = render(store, invoice.id);

    expect(text).toContain("2026-07-20");
    expect(text).toContain("J. Okafor");
    expect(text).toContain("Reviewed discovery production and indexed exhibits");
    expect(text).toContain("3.50 hours @ $250.00");
    expect(text).toContain("$875.00");

    expect(text).toContain("2026-07-22");
    expect(text).toContain("L. Reyes");
    expect(text).toContain("Drafted motion to suppress");
    expect(text).toContain("$800.00");
  });

  it("separates services, expenses and fixed fees rather than merging them", () => {
    const { store, invoice } = invoiceWithWork();
    const { text } = render(store, invoice.id);
    expect(text).toContain("PROFESSIONAL SERVICES");
    expect(text).toContain("EXPENSES AND DISBURSEMENTS");
    // No flat lines on this invoice, so that heading must not appear.
    expect(text).not.toContain("FIXED FEES");
    expect(text).toContain("Professional services total: $1,675.00");
    expect(text).toContain("Expenses and disbursements total: $75.00");
  });

  it("totals to the sum of the printed lines, to the cent", () => {
    const { store, invoice } = invoiceWithWork();
    const { text } = render(store, invoice.id);
    // 875.00 + 800.00 + 75.00
    expect(text).toContain("TOTAL:            $1,750.00");
    expect(text).toContain("BALANCE DUE:      $1,750.00");
  });

  it("shows payments received and the remaining balance", () => {
    const { store, invoice } = invoiceWithWork();
    store.send(invoice.id);
    store.recordPayment({ invoiceId: invoice.id, amountCents: 750_00, method: "check", reference: "1041", recordedBy: "a1" });
    const { text } = render(store, invoice.id);
    expect(text).toContain("PAYMENTS RECEIVED");
    expect(text).toContain("Check (1041)");
    expect(text).toContain("BALANCE DUE:      $1,000.00");
  });

  it("names the matter in the subject so a client can tell two bills apart", () => {
    const { store, invoice } = invoiceWithWork();
    expect(render(store, invoice.id).subject).toBe(`Invoice ${invoice.number} — State v. Ruiz`);
  });

  it("says outright that a draft has not been issued", () => {
    const { store, invoice } = invoiceWithWork();
    expect(render(store, invoice.id).text).toContain("draft — not yet issued");
    store.send(invoice.id);
    expect(render(store, invoice.id).text).not.toContain("draft — not yet issued");
  });

  it("marks a voided invoice as void, with the reason", () => {
    const { store, invoice } = invoiceWithWork();
    store.void(invoice.id, "billed to the wrong matter");
    const { text, html } = render(store, invoice.id);
    expect(text).toContain("VOID — billed to the wrong matter");
    expect(html).toContain("billed to the wrong matter");
  });
});

describe("renderInvoice — HTML", () => {
  it("escapes content so a description can't inject markup into a client's mail", () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1" });
    store.addLineItem(invoice.id, {
      description: '<script>alert("x")</script>',
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: 100,
    });
    const { html } = render(store, invoice.id);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries the same figures as the text version", () => {
    const { store, invoice } = invoiceWithWork();
    const { html } = render(store, invoice.id);
    expect(html).toContain("$1,750.00");
    expect(html).toContain("Reviewed discovery production and indexed exhibits");
    expect(html).toContain("J. Okafor");
    expect(html).toContain("3.50");
  });
});

describe("money and quantity formatting", () => {
  it("formats cents without floating-point drift", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
    expect(formatCents(-2_50)).toBe("-$2.50");
  });

  it("formats thousandths as two decimal places", () => {
    expect(formatQuantity(7_500)).toBe("7.50");
    expect(formatQuantity(100)).toBe("0.10");
    expect(formatQuantity(1_000)).toBe("1.00");
  });
});
