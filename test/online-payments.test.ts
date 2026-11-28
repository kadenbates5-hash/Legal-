import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { InvoiceStore } from "../src/core/invoicing.js";
import { InvoicingService } from "../src/review-ui/invoicing-service.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { ManualPaymentProcessor } from "../src/integrations/payment-processor.js";
import { parseCheckoutSessionCompletedEvent, type StripeCheckoutCompletedEvent } from "../src/integrations/stripe-checkout.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

/**
 * Money a client paid online used to be capped down to the balance — the
 * rest dropped without a trace — and a voided or unknown invoice meant the
 * whole charge went unrecorded. A bank debit was recorded as paid the
 * moment it was authorised, days before it cleared.
 */
const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const system: Actor = { id: "system", role: "system" };

function setup() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-other");
  const store = new InvoiceStore();
  const service = new InvoicingService({
    store,
    accessControl,
    auditLog,
    trust: new TrustLedger(),
    billingHours: new BillingHoursStore(),
    processor: new ManualPaymentProcessor(),
  });
  const draft = service.createDraft(attorney, "m-1", {});
  service.addLineItem(attorney, "m-1", draft.id, { description: "Consultation", source: "flat", quantityMilli: 1_000, unitAmountCents: 300_00 });
  service.send(attorney, "m-1", draft.id);
  return { service, store, auditLog, invoiceId: draft.id };
}

function paid(invoiceId: string, n: number, amountTotalCents = 300_00): StripeCheckoutCompletedEvent {
  return { sessionId: `cs_${n}`, paymentIntentId: `pi_${n}`, amountTotalCents, matterId: "m-1", invoiceId, method: "card" };
}

describe("which webhook events are money", () => {
  const session = (extra: Record<string, unknown>, type = "checkout.session.completed") =>
    JSON.stringify({
      type,
      data: { object: { id: "cs_1", payment_intent: "pi_1", amount_total: 300_00, metadata: { matterId: "m-1", invoiceId: "inv_1" }, ...extra } },
    });

  it("is only a paid session — an authorised bank debit hasn't arrived yet", () => {
    expect(parseCheckoutSessionCompletedEvent(session({ payment_status: "paid" }))?.method).toBe("card");
    expect(parseCheckoutSessionCompletedEvent(session({ payment_status: "unpaid", payment_method_types: ["us_bank_account"] }))).toBeUndefined();
    expect(parseCheckoutSessionCompletedEvent(session({}))).toBeUndefined();
  });

  it("records a delayed payment when it clears, as the method it was", () => {
    const cleared = parseCheckoutSessionCompletedEvent(
      session({ payment_status: "paid", payment_method_types: ["card", "us_bank_account"] }, "checkout.session.async_payment_succeeded"),
    );
    expect(cleared).toMatchObject({ sessionId: "cs_1", amountTotalCents: 300_00, method: "ach" });
    expect(
      parseCheckoutSessionCompletedEvent(session({ payment_status: "paid", payment_method_types: ["sepa_debit"] }, "checkout.session.async_payment_succeeded"))
        ?.method,
    ).toBe("other");
    expect(parseCheckoutSessionCompletedEvent(session({ payment_status: "unpaid" }, "checkout.session.async_payment_failed"))).toBeUndefined();
  });

  it("ignores a session for no money at all", () => {
    expect(parseCheckoutSessionCompletedEvent(session({ payment_status: "paid", amount_total: 0 }))).toBeUndefined();
    expect(parseCheckoutSessionCompletedEvent(session({ payment_status: "paid", amount_total: 12.5 }))).toBeUndefined();
  });
});

describe("money that can't go on the bill", () => {
  it("keeps a second payment from another tab, in full", () => {
    const { service, invoiceId } = setup();
    service.recordCheckoutPayment(system, paid(invoiceId, 1));
    const second = service.recordCheckoutPayment(system, paid(invoiceId, 2));
    expect(second.invoice!.payments).toHaveLength(1);
    expect(second.unapplied).toMatchObject({ amountCents: 300_00, receivedCents: 300_00, reason: "nothing_owed", references: ["pi_2", "cs_2"] });
  });

  it("keeps what's over the balance when a check was recorded meanwhile", () => {
    const { service, store, invoiceId } = setup();
    store.recordPayment({ invoiceId, amountCents: 100_00, method: "check", recordedBy: "a1" });
    const result = service.recordCheckoutPayment(system, paid(invoiceId, 1));
    expect(result.invoice!.totals.balanceCents).toBe(0);
    expect(result.unapplied).toMatchObject({ amountCents: 100_00, receivedCents: 300_00, reason: "overpaid" });
  });

  it("keeps the whole charge for a voided invoice, and puts nothing on it", () => {
    const { service, store, invoiceId } = setup();
    service.void(attorney, "m-1", invoiceId, "reissued");
    const result = service.recordCheckoutPayment(system, paid(invoiceId, 1));
    expect(store.paymentsFor(invoiceId)).toEqual([]);
    expect(result.unapplied).toMatchObject({ amountCents: 300_00, reason: "invoice_void" });
  });

  it("keeps the charge when the invoice isn't on that matter", () => {
    const { service, invoiceId } = setup();
    const result = service.recordCheckoutPayment(system, { ...paid(invoiceId, 1), matterId: "m-other" });
    expect(result.invoice).toBeUndefined();
    expect(result.unapplied).toMatchObject({ matterId: "m-other", reason: "invoice_missing" });
  });

  it("does nothing more for a retried webhook, whichever way it went the first time", () => {
    const { service, store, invoiceId } = setup();
    service.void(attorney, "m-1", invoiceId, "reissued");
    service.recordCheckoutPayment(system, paid(invoiceId, 1));
    expect(service.recordCheckoutPayment(system, paid(invoiceId, 1)).unapplied).toBeUndefined();
    expect(store.unappliedReceipts()).toHaveLength(1);
  });

  it("writes each to the audit log", () => {
    const { service, auditLog, invoiceId } = setup();
    service.recordCheckoutPayment(system, paid(invoiceId, 1, 450_00));
    const actions = auditLog.read("attorney").map((e) => e.action);
    expect(actions).toContain("invoice_payment_recorded");
    expect(actions).toContain("online_payment_unapplied");
  });

  it("survives a restart, and an older state file with none loads", () => {
    const { service, store, invoiceId } = setup();
    service.recordCheckoutPayment(system, paid(invoiceId, 1, 450_00));
    const reloaded = InvoiceStore.fromSnapshot(JSON.parse(JSON.stringify(store.toSnapshot())));
    expect(reloaded.unappliedReceipts()).toHaveLength(1);
    expect(reloaded.hasProcessorReference("pi_1")).toBe(true);
    const { unappliedReceipts: _, ...older } = store.toSnapshot();
    expect(InvoiceStore.fromSnapshot(older).unappliedReceipts()).toEqual([]);
  });
});

describe("resolving it", () => {
  it("is listed to staff who can reach the matter, and resolved by an attorney, once, with a note", () => {
    const { service, invoiceId } = setup();
    const { unapplied } = service.recordCheckoutPayment(system, paid(invoiceId, 1, 450_00));
    expect(service.listUnappliedReceipts(attorney).map((r) => r.id)).toEqual([unapplied!.id]);
    expect(service.listUnappliedReceipts(paralegal)).toEqual([]); // assigned to another matter

    expect(() => service.resolveUnappliedReceipt(paralegal, unapplied!.id, "refunded")).toThrow(AccessDeniedError);
    expect(() => service.resolveUnappliedReceipt(attorney, unapplied!.id, "   ")).toThrow(/a note is required/);
    const resolved = service.resolveUnappliedReceipt(attorney, unapplied!.id, "Refunded in Stripe, re_123");
    expect(resolved).toMatchObject({ resolvedBy: "a1", resolution: "Refunded in Stripe, re_123" });
    expect(() => service.resolveUnappliedReceipt(attorney, unapplied!.id, "again")).toThrow(/already resolved/);

    expect(service.listUnappliedReceipts(attorney)).toEqual([]);
    expect(service.listUnappliedReceipts(attorney, { includeResolved: true })).toHaveLength(1);
  });
});

describe("over HTTP", () => {
  const WEBHOOK_SECRET = "whsec_test";
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  let invoiceId: string;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const built = setup();
    invoiceId = built.invoiceId;
    built.service.void(attorney, "m-1", invoiceId, "reissued");
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      invoicing: built.service,
      stripeWebhook: { webhookSecret: WEBHOOK_SECRET },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cookie = await login("attorney1");
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function login(username: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "correct-horse" }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  async function webhook(payload: unknown) {
    const raw = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
    return fetch(`${baseUrl}/api/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${v1}` }, body: raw });
  }

  it("keeps a payment for a voided invoice and lets an attorney record the refund", async () => {
    const res = await webhook({
      type: "checkout.session.completed",
      data: { object: { id: "cs_9", payment_intent: "pi_9", amount_total: 300_00, payment_status: "paid", metadata: { matterId: "m-1", invoiceId } } },
    });
    expect(res.status).toBe(200);

    const list = await (await fetch(`${baseUrl}/api/invoices/unapplied-receipts`, { headers: { cookie } })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 300_00, reason: "invoice_void" });

    const resolve = (body: unknown, as = cookie) =>
      fetch(`${baseUrl}/api/invoices/unapplied-receipts/${list[0].id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: as },
        body: JSON.stringify(body),
      });
    expect((await resolve({ resolution: "" })).status).toBe(400);
    expect((await resolve({ resolution: "refunded" }, await login("reception1"))).status).toBe(403);
    expect((await resolve({ resolution: "Refunded in Stripe, re_9" })).status).toBe(200);
    expect((await resolve({ resolution: "again" })).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/invoices/unapplied-receipts/rcpt_nope/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ resolution: "x" }),
    })).status).toBe(404);
  });

  it("records nothing for a bank debit that hasn't cleared", async () => {
    const res = await webhook({
      type: "checkout.session.completed",
      data: { object: { id: "cs_8", payment_intent: "pi_8", amount_total: 300_00, payment_status: "unpaid", metadata: { matterId: "m-1", invoiceId } } },
    });
    expect(res.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/api/invoices/unapplied-receipts`, { headers: { cookie } })).json()).toEqual([]);
  });
});
