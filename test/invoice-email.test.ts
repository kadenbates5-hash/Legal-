import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { MatterStore, billingEmailFor } from "../src/core/matters.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { InvoicingService } from "../src/review-ui/invoicing-service.js";
import { ManualPaymentProcessor } from "../src/integrations/payment-processor.js";
import { PdfLibInvoicePdfRenderer } from "../src/integrations/invoice-pdf.js";
import {
  UnconfiguredEmailSender,
  assertSafeEmailAddress,
  type EmailMessage,
  type EmailResult,
  type EmailSender,
} from "../src/integrations/email-sender.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

/** Records what it was asked to send; optionally fails, to test the ordering guarantee. */
class FakeEmailSender implements EmailSender {
  readonly name = "fake";
  readonly canSend = true;
  readonly fromAddress = "billing@firm.example";
  sent: EmailMessage[] = [];
  failWith: Error | undefined;

  async send(message: EmailMessage): Promise<EmailResult> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { messageId: `<msg-${this.sent.length}@firm.example>` };
  }
}

function setup(options: { email?: EmailSender; pdf?: boolean } = {}) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");
  const auth = new AuthService();
  auth.createUser({ username: "p1", password: "correct-horse", role: "paralegal", actorId: "p1", displayName: "Jo Okafor" });
  const matters = new MatterStore();
  matters.upsert("m-1", {
    title: "State v. Ruiz",
    parties: [
      { name: "Maria Ruiz", role: "client", note: undefined, email: "maria@example.com" },
      { name: "The State", role: "adverse", note: undefined, email: "prosecutor@example.gov" },
    ],
  });
  const store = new InvoiceStore();
  const billingHours = new BillingHoursStore();
  const email = options.email ?? new FakeEmailSender();
  const service = new InvoicingService({
    store,
    accessControl,
    auditLog,
    trust: new TrustLedger(),
    billingHours,
    processor: new ManualPaymentProcessor(),
    email,
    ...(options.pdf === false ? {} : { pdf: new PdfLibInvoicePdfRenderer() }),
    matters,
    auth,
    firm: { name: "Reyes & Okafor LLP" },
  });
  return { service, store, billingHours, auditLog, email, matters };
}

function draftWithALine(ctx: ReturnType<typeof setup>) {
  const invoice = ctx.service.createDraft(attorney, "m-1", {});
  ctx.service.addLineItem(attorney, "m-1", invoice.id, {
    description: "Drafted motion to suppress",
    source: "time",
    quantityMilli: 2_000,
    unitAmountCents: 400_00,
    workedOn: "2026-07-22",
    timekeeperId: "p1",
  });
  return invoice;
}

describe("assertSafeEmailAddress", () => {
  it("accepts an ordinary address", () => {
    expect(assertSafeEmailAddress(" maria@example.com ")).toBe("maria@example.com");
  });

  it("rejects anything that could inject a second recipient or a header", () => {
    for (const bad of [
      "maria@example.com\nBcc: leak@evil.example",
      "maria@example.com\r\nBcc: leak@evil.example",
      "maria@example.com, leak@evil.example",
      "maria@example.com; leak@evil.example",
      '"Maria" <maria@example.com>',
      "not-an-address",
      "",
    ]) {
      expect(() => assertSafeEmailAddress(bad)).toThrow();
    }
  });
});

describe("InvoicingService — emailing an invoice", () => {
  it("sends the itemised invoice to the client on the matter record", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    const view = await ctx.service.emailInvoice(attorney, "m-1", invoice.id);

    const sent = (ctx.email as FakeEmailSender).sent[0]!;
    expect(sent.to).toBe("maria@example.com");
    expect(sent.subject).toContain("State v. Ruiz");
    expect(sent.text).toContain("Drafted motion to suppress");
    expect(sent.text).toContain("2026-07-22");
    // The timekeeper resolves to a display name, not a raw actor id.
    expect(sent.text).toContain("Jo Okafor");
    expect(sent.html).toContain("$800.00");
    // Emailing a draft issues it.
    expect(view.status).toBe("sent");
    expect(view.deliveries).toHaveLength(1);
    expect(view.deliveries[0]!.to).toBe("maria@example.com");
    // The client's copy must not tell them it hasn't been issued.
    expect(sent.text).not.toContain("not yet issued");
    expect(sent.text).toContain(`Issued:  ${new Date().toISOString().slice(0, 10)}`);
  });

  it("never falls back to a non-client party's address", async () => {
    const ctx = setup();
    ctx.matters.upsert("m-2", {
      parties: [{ name: "The State", role: "adverse", note: undefined, email: "prosecutor@example.gov" }],
    });
    const invoice = ctx.service.createDraft(attorney, "m-2", {});
    ctx.service.addLineItem(attorney, "m-2", invoice.id, {
      description: "Fee",
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: 100_00,
    });
    await expect(ctx.service.emailInvoice(attorney, "m-2", invoice.id)).rejects.toThrow(/no client email/i);
    expect((ctx.email as FakeEmailSender).sent).toHaveLength(0);
  });

  it("leaves the invoice an editable draft when the mail fails", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    (ctx.email as FakeEmailSender).failWith = new Error("smtp unreachable");

    await expect(ctx.service.emailInvoice(attorney, "m-1", invoice.id)).rejects.toThrow(/smtp unreachable/);

    // Still a draft: an invoice the client never received must not be
    // stuck as issued with its lines locked.
    const after = ctx.service.get(attorney, "m-1", invoice.id);
    expect(after.status).toBe("draft");
    expect(after.deliveries).toHaveLength(0);
    expect(() =>
      ctx.service.addLineItem(attorney, "m-1", invoice.id, {
        description: "Another task",
        source: "time",
        quantityMilli: 1_000,
        unitAmountCents: 400_00,
      }),
    ).not.toThrow();
  });

  it("is attorney-only", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    await expect(ctx.service.emailInvoice(paralegal, "m-1", invoice.id)).rejects.toThrow(AccessDeniedError);
  });

  it("refuses an address that could smuggle in a second recipient", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    await expect(
      ctx.service.emailInvoice(attorney, "m-1", invoice.id, "maria@example.com\nBcc: leak@evil.example"),
    ).rejects.toThrow(/does not look like/i);
    expect((ctx.email as FakeEmailSender).sent).toHaveLength(0);
  });

  it("refuses to email an empty invoice or a voided one", async () => {
    const ctx = setup();
    const empty = ctx.service.createDraft(attorney, "m-1", {});
    await expect(ctx.service.emailInvoice(attorney, "m-1", empty.id)).rejects.toThrow(/no line items/i);

    const voided = draftWithALine(ctx);
    ctx.service.void(attorney, "m-1", voided.id, "wrong matter");
    await expect(ctx.service.emailInvoice(attorney, "m-1", voided.id)).rejects.toThrow(/void/i);
  });

  it("can resend a copy of an already-sent invoice, recording each delivery", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    await ctx.service.emailInvoice(attorney, "m-1", invoice.id);
    const view = await ctx.service.emailInvoice(attorney, "m-1", invoice.id, "maria.alt@example.com");
    expect(view.deliveries.map((d) => d.to)).toEqual(["maria@example.com", "maria.alt@example.com"]);
  });

  it("audits the send, with the recipient and the amount", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    await ctx.service.emailInvoice(attorney, "m-1", invoice.id);
    const entry = ctx.auditLog.read("attorney").find((e) => e.action === "invoice_emailed");
    expect(entry?.detail).toContain("to=maria@example.com");
    expect(entry?.detail).toContain("totalCents=80000");
  });

  it("says so plainly when no mail transport is configured", async () => {
    const ctx = setup({ email: new UnconfiguredEmailSender() });
    const invoice = draftWithALine(ctx);
    expect(ctx.service.emailInfo(attorney).canSend).toBe(false);
    await expect(ctx.service.emailInvoice(attorney, "m-1", invoice.id)).rejects.toThrow(/no email transport/i);
    expect(ctx.service.get(attorney, "m-1", invoice.id).status).toBe("draft");
  });
});

describe("InvoicingService — preview", () => {
  it("returns the same document that would be emailed, plus the suggested recipient", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    const preview = ctx.service.preview(attorney, "m-1", invoice.id);
    expect(preview.suggestedTo).toBe("maria@example.com");

    await ctx.service.emailInvoice(attorney, "m-1", invoice.id);
    // Same document, so what an attorney reviewed is what the client got.
    // The only line that differs is the issue date, which the preview
    // honestly shows as "not yet issued".
    const stripIssued = (body: string) => body.replace(/^Issued:.*$/m, "");
    expect(stripIssued((ctx.email as FakeEmailSender).sent[0]!.text)).toBe(stripIssued(preview.text));
  });

  it("is available to a paralegal preparing the bill", () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    expect(ctx.service.preview(paralegal, "m-1", invoice.id).text).toContain("Drafted motion to suppress");
  });
});

describe("InvoicingService — pulling logged time onto an invoice", () => {
  it("carries the date, timekeeper and source entry onto each line", () => {
    const ctx = setup();
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 3.5, description: "Discovery review" });
    const invoice = ctx.service.createDraft(attorney, "m-1", {});
    const view = ctx.service.addTimeFromBillingHours(attorney, "m-1", invoice.id, 250_00);

    expect(view.lineItems).toHaveLength(1);
    expect(view.lineItems[0]).toMatchObject({
      description: "Discovery review",
      workedOn: "2026-07-20",
      timekeeperId: "p1",
      amountCents: 875_00,
    });
    expect(view.lineItems[0]!.sourceEntryId).toBeDefined();
  });

  it("refuses to bill the same logged hours onto a second invoice", () => {
    const ctx = setup();
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 3.5, description: "Discovery review" });
    const first = ctx.service.createDraft(attorney, "m-1", {});
    ctx.service.addTimeFromBillingHours(attorney, "m-1", first.id, 250_00);

    const second = ctx.service.createDraft(attorney, "m-1", {});
    expect(() => ctx.service.addTimeFromBillingHours(attorney, "m-1", second.id, 250_00)).toThrow(/already on an invoice/i);
  });

  it("only adds the hours logged since the last invoice", () => {
    const ctx = setup();
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 3.5, description: "Discovery review" });
    const first = ctx.service.createDraft(attorney, "m-1", {});
    ctx.service.addTimeFromBillingHours(attorney, "m-1", first.id, 250_00);

    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-25", hours: 2, description: "Client meeting" });
    const second = ctx.service.createDraft(attorney, "m-1", {});
    const view = ctx.service.addTimeFromBillingHours(attorney, "m-1", second.id, 250_00);
    expect(view.lineItems.map((l) => l.description)).toEqual(["Client meeting"]);
  });

  it("releases hours back for re-billing when the invoice is voided", () => {
    const ctx = setup();
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 3.5, description: "Discovery review" });
    const first = ctx.service.createDraft(attorney, "m-1", {});
    ctx.service.addTimeFromBillingHours(attorney, "m-1", first.id, 250_00);
    ctx.service.void(attorney, "m-1", first.id, "wrong rate");

    const second = ctx.service.createDraft(attorney, "m-1", {});
    const view = ctx.service.addTimeFromBillingHours(attorney, "m-1", second.id, 300_00);
    expect(view.lineItems).toHaveLength(1);
    expect(view.lineItems[0]!.amountCents).toBe(1_050_00);
  });

  it("sorts lines by the date the work was done", () => {
    const ctx = setup();
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-25", hours: 1, description: "Later" });
    ctx.billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 1, description: "Earlier" });
    const invoice = ctx.service.createDraft(attorney, "m-1", {});
    const view = ctx.service.addTimeFromBillingHours(attorney, "m-1", invoice.id, 100_00);
    expect(view.lineItems.map((l) => l.description)).toEqual(["Earlier", "Later"]);
  });
});

/* ===== HTTP routes ===== */
describe("invoice email/preview HTTP API", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let cookies: Record<string, string>;
  let email: FakeEmailSender;

  async function start() {
    const { createReviewServer } = await import("../src/review-ui/server.js");
    const { ReviewGateService } = await import("../src/review-ui/review-service.js");
    const { WorkProductStore } = await import("../src/core/work-product-store.js");
    const ctx = setup();
    email = ctx.email as FakeEmailSender;
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { invoicing: ctx.service });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    cookies = {};
    for (const username of ["attorney1", "paralegal1"]) {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "correct-horse" }),
      });
      cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
    }
    return ctx;
  }

  const post = (cookie: string, path: string, body: unknown = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  const get = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });

  it("previews, emails and reports the transport over HTTP", async () => {
    const ctx = await start();
    try {
      const invoice = draftWithALine(ctx);
      const transport = await (await get(cookies["attorney1"]!, "/api/invoices/email-transport")).json();
      expect(transport).toMatchObject({ canSend: true, fromAddress: "billing@firm.example" });

      const preview = await (
        await get(cookies["attorney1"]!, `/api/invoices/matters/m-1/${invoice.id}/preview`)
      ).json();
      expect(preview.suggestedTo).toBe("maria@example.com");
      expect(preview.text).toContain("Drafted motion to suppress");

      const emailed = await post(cookies["attorney1"]!, `/api/invoices/matters/m-1/${invoice.id}/email`);
      expect(emailed.status).toBe(200);
      expect((await emailed.json()).status).toBe("sent");
      expect(email.sent).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serves the PDF as a real binary download with a filename", async () => {
    const ctx = await start();
    try {
      const invoice = draftWithALine(ctx);
      const res = await get(cookies["attorney1"]!, `/api/invoices/matters/m-1/${invoice.id}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="${invoice.number} State v. Ruiz.pdf"`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(Number(res.headers.get("content-length"))).toBe(body.byteLength);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("403s a paralegal emailing, and 400s a malformed address", async () => {
    const ctx = await start();
    try {
      const invoice = draftWithALine(ctx);
      expect((await post(cookies["paralegal1"]!, `/api/invoices/matters/m-1/${invoice.id}/email`)).status).toBe(403);
      const bad = await post(cookies["attorney1"]!, `/api/invoices/matters/m-1/${invoice.id}/email`, {
        to: "maria@example.com\nBcc: leak@evil.example",
      });
      expect(bad.status).toBe(400);
      expect(email.sent).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("InvoicingService — the PDF invoice", () => {
  it("attaches the invoice as a PDF to the outgoing email", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    await ctx.service.emailInvoice(attorney, "m-1", invoice.id);

    const sent = (ctx.email as FakeEmailSender).sent[0]!;
    expect(sent.attachments).toHaveLength(1);
    const attachment = sent.attachments![0]!;
    expect(attachment.contentType).toBe("application/pdf");
    expect(attachment.filename).toBe(`${invoice.number} State v. Ruiz.pdf`);
    expect(attachment.content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("sends no attachment when no PDF renderer is configured", async () => {
    const ctx = setup({ pdf: false });
    const invoice = draftWithALine(ctx);
    await ctx.service.emailInvoice(attorney, "m-1", invoice.id);
    expect((ctx.email as FakeEmailSender).sent[0]!.attachments).toBeUndefined();
  });

  it("downloads the PDF for an attorney or the paralegal preparing it", async () => {
    const ctx = setup();
    const invoice = draftWithALine(ctx);
    for (const actor of [attorney, paralegal]) {
      const { filename, data } = await ctx.service.renderPdf(actor, "m-1", invoice.id);
      expect(filename).toBe(`${invoice.number} State v. Ruiz.pdf`);
      expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("refuses a PDF for a matter the caller isn't on", async () => {
    const ctx = setup();
    ctx.matters.upsert("m-2", { title: "Other matter" });
    const invoice = ctx.service.createDraft(attorney, "m-2", {});
    await expect(ctx.service.renderPdf(paralegal, "m-2", invoice.id)).rejects.toThrow(AccessDeniedError);
  });
});

describe("billingEmailFor", () => {
  it("returns the first client party with an address", () => {
    const matters = new MatterStore();
    matters.upsert("m-1", {
      parties: [
        { name: "No Email Co", role: "client", note: undefined, email: undefined },
        { name: "Maria Ruiz", role: "client", note: undefined, email: "maria@example.com" },
      ],
    });
    expect(billingEmailFor(matters.get("m-1"))).toBe("maria@example.com");
  });

  it("never returns an adverse or related party's address", () => {
    const matters = new MatterStore();
    matters.upsert("m-1", {
      parties: [
        { name: "The State", role: "adverse", note: undefined, email: "prosecutor@example.gov" },
        { name: "A Witness", role: "related", note: undefined, email: "witness@example.com" },
      ],
    });
    expect(billingEmailFor(matters.get("m-1"))).toBeUndefined();
  });

  it("ignores a blank address and an unknown matter", () => {
    const matters = new MatterStore();
    matters.upsert("m-1", { parties: [{ name: "Maria Ruiz", role: "client", note: undefined, email: "   " }] });
    expect(billingEmailFor(matters.get("m-1"))).toBeUndefined();
    expect(billingEmailFor(matters.get("nope"))).toBeUndefined();
  });

  it("survives a snapshot round trip, so a restart can't lose where bills go", () => {
    const matters = new MatterStore();
    matters.upsert("m-1", {
      parties: [{ name: "Maria Ruiz", role: "client", note: undefined, email: "maria@example.com" }],
    });
    const restored = MatterStore.fromSnapshot(matters.toSnapshot());
    expect(billingEmailFor(restored.get("m-1"))).toBe("maria@example.com");
  });
});

describe("InvoicingService — outstanding receivables", () => {
  /** An issued invoice on `matterId` for `amountCents`, optionally with a due date. */
  function issued(ctx: ReturnType<typeof setup>, matterId: string, amountCents: number, dueDate?: string) {
    const invoice = ctx.service.createDraft(attorney, matterId, dueDate ? { dueDate } : {});
    ctx.service.addLineItem(attorney, matterId, invoice.id, {
      description: "Work",
      source: "flat",
      quantityMilli: 1_000,
      unitAmountCents: amountCents,
    });
    ctx.service.send(attorney, matterId, invoice.id);
    return invoice;
  }

  const asOf = new Date("2026-08-15T12:00:00Z");

  it("lists only issued, unpaid invoices", () => {
    const ctx = setup();
    const unpaid = issued(ctx, "m-1", 500_00);
    // A draft isn't money anyone owes yet.
    draftWithALine(ctx);
    // A fully paid one drops off.
    const paid = issued(ctx, "m-1", 200_00);
    ctx.service.recordPayment(attorney, "m-1", paid.id, { amountCents: 200_00, method: "check" });
    // So does a voided one.
    const voided = issued(ctx, "m-1", 300_00);
    ctx.service.void(attorney, "m-1", voided.id, "duplicate");

    const rows = ctx.service.listOutstanding(attorney, asOf);
    expect(rows.map((r) => r.id)).toEqual([unpaid.id]);
    expect(rows[0]!.totals.balanceCents).toBe(500_00);
  });

  it("counts a partly paid invoice at its remaining balance", () => {
    const ctx = setup();
    const invoice = issued(ctx, "m-1", 1_000_00);
    ctx.service.recordPayment(attorney, "m-1", invoice.id, { amountCents: 400_00, method: "check" });
    const rows = ctx.service.listOutstanding(attorney, asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totals.balanceCents).toBe(600_00);
    expect(rows[0]!.status).toBe("partially_paid");
  });

  it("computes days overdue from the due date, and treats a future date as not overdue", () => {
    const ctx = setup();
    issued(ctx, "m-1", 100_00, "2026-08-01"); // 14 days past
    issued(ctx, "m-1", 200_00, "2026-09-01"); // not yet due
    issued(ctx, "m-1", 300_00); // no due date at all

    const byNumber = Object.fromEntries(ctx.service.listOutstanding(attorney, asOf).map((r) => [r.dueDate ?? "none", r.daysOverdue]));
    expect(byNumber["2026-08-01"]).toBe(14);
    expect(byNumber["2026-09-01"]).toBe(0);
    expect(byNumber["none"]).toBe(0);
  });

  it("sorts most overdue first, then by largest balance", () => {
    const ctx = setup();
    issued(ctx, "m-1", 100_00, "2026-08-10"); // 5 days
    issued(ctx, "m-1", 900_00, "2026-07-01"); // 45 days
    issued(ctx, "m-1", 500_00); // not overdue
    issued(ctx, "m-1", 800_00); // not overdue, bigger

    const rows = ctx.service.listOutstanding(attorney, asOf);
    expect(rows.map((r) => r.totals.balanceCents)).toEqual([900_00, 100_00, 800_00, 500_00]);
  });

  it("shows a paralegal only their own matter's receivables, without erroring on the rest", () => {
    const ctx = setup();
    ctx.matters.upsert("m-2", { title: "Someone else's case" });
    const mine = issued(ctx, "m-1", 100_00);
    issued(ctx, "m-2", 999_00);

    // The attorney sees both; the paralegal is assigned only to m-1.
    expect(ctx.service.listOutstanding(attorney, asOf)).toHaveLength(2);
    const theirs = ctx.service.listOutstanding(paralegal, asOf);
    expect(theirs.map((r) => r.id)).toEqual([mine.id]);
  });

  it("carries the client and matter title so a receivable can be chased without opening the matter", () => {
    const ctx = setup();
    issued(ctx, "m-1", 100_00);
    const row = ctx.service.listOutstanding(attorney, asOf)[0]!;
    expect(row.clientName).toBe("Maria Ruiz");
    expect(row.matterTitle).toBe("State v. Ruiz");
  });

  it("is closed to a receptionist", () => {
    const ctx = setup();
    expect(() => ctx.service.listOutstanding({ id: "r1", role: "receptionist" }, asOf)).toThrow(AccessDeniedError);
  });
});
