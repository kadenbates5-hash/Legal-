import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { InvoicingService } from "../src/review-ui/invoicing-service.js";
import { ClientPortalService } from "../src/review-ui/client-portal-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { MatterStore } from "../src/core/matters.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { ManualPaymentProcessor } from "../src/integrations/payment-processor.js";

let server: Server;
let baseUrl: string;
let clientCookie: string;
let attorneyCookie: string;
let documents: DocumentsService;
let invoicing: InvoicingService;
let matters: MatterStore;

async function loginCookie(username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "correct-horse" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: cookie } };
}

const get = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, withCookie(cookie));

beforeEach(async () => {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "client1", password: "correct-horse", role: "client", actorId: "c1" });
  auth.createUser({ username: "client2", password: "correct-horse", role: "client", actorId: "c2" });

  matters = new MatterStore();
  matters.upsert("m1", { title: "State v. Ruiz", status: "open", parties: [] });
  accessControl.grantClientAccess("c1", "m1");

  const documentStore = new DocumentStore();
  documents = new DocumentsService({ accessControl, store: documentStore, auditLog });
  const trust = new TrustLedger();
  const invoiceStore = new InvoiceStore();
  invoicing = new InvoicingService({
    store: invoiceStore,
    accessControl,
    auditLog,
    trust,
    billingHours: new BillingHoursStore(),
    processor: new ManualPaymentProcessor(),
  });
  const clientPortal = new ClientPortalService({ accessControl, matters, documents: documentStore, trust, invoicing });
  const accounts = new AccountsService(auth, accessControl, undefined, auditLog);

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    clientPortal,
    documents,
    accounts,
    auditLog,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  clientCookie = await loginCookie("client1");
  attorneyCookie = await loginCookie("attorney1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("client portal HTTP API", () => {
  it("404s when the client portal isn't configured", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "c", password: "correct-horse", role: "client", actorId: "c1" });
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {});
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const { port } = bareServer.address() as AddressInfo;
    const bareUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${bareUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "c", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${bareUrl}/api/client-portal/matters`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it("lists a client's own matters and rejects a staff role", async () => {
    const res = await get(clientCookie, "/api/client-portal/matters");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ matterId: "m1", title: "State v. Ruiz", status: "open" }]);

    const denied = await get(attorneyCookie, "/api/client-portal/matters");
    expect(denied.status).toBe(403);
  });

  it("gives a client matter detail, and refuses one it wasn't granted", async () => {
    const ok = await get(clientCookie, "/api/client-portal/matters/m1");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { matterId: string; title: string; documents: unknown[] };
    expect(body).toMatchObject({ matterId: "m1", title: "State v. Ruiz", documents: [] });

    matters.upsert("m2", { title: "Not this client's matter", status: "open", parties: [] });
    const denied = await get(clientCookie, "/api/client-portal/matters/m2");
    expect(denied.status).toBe(403);
  });

  it("cross-client isolation: c2 sees nothing of c1's matter", async () => {
    const c2Cookie = await loginCookie("client2");
    expect((await get(c2Cookie, "/api/client-portal/matters")).status).toBe(200);
    expect(await (await get(c2Cookie, "/api/client-portal/matters")).json()).toEqual([]);
    expect((await get(c2Cookie, "/api/client-portal/matters/m1")).status).toBe(403);
  });

  it("only serves a document once staff shares it, and streams the actual bytes with the right content type", async () => {
    const attorneyActor = { id: "a1", role: "attorney" as const };
    const doc = documents.upload(attorneyActor, "m1", {
      fileName: "letter.pdf",
      contentType: "application/pdf",
      content: Buffer.from("hello world").toString("base64"),
    });

    const beforeShare = await get(clientCookie, `/api/client-portal/matters/m1/documents/${doc.id}`);
    expect(beforeShare.status).toBe(404);

    documents.setClientVisibility(attorneyActor, "m1", doc.id, true);
    const afterShare = await get(clientCookie, `/api/client-portal/matters/m1/documents/${doc.id}`);
    expect(afterShare.status).toBe(200);
    expect(afterShare.headers.get("content-type")).toBe("application/pdf");
    expect(await afterShare.text()).toBe("hello world");
  });

  it("lets a client upload a document to their own matter, visible to them immediately, and rejects a staff role", async () => {
    const res = await fetch(`${baseUrl}/api/client-portal/matters/m1/documents`, withCookie(clientCookie, {
      method: "POST",
      body: JSON.stringify({ fileName: "id-scan.pdf", contentType: "application/pdf", content: Buffer.from("scan bytes").toString("base64") }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ fileName: "id-scan.pdf", matterId: "m1" });

    const matterDetail = await (await get(clientCookie, "/api/client-portal/matters/m1")).json();
    expect(matterDetail.documents).toEqual(expect.arrayContaining([expect.objectContaining({ id: body.id })]));

    const staffAttempt = await fetch(`${baseUrl}/api/client-portal/matters/m1/documents`, withCookie(attorneyCookie, {
      method: "POST",
      body: JSON.stringify({ fileName: "x.pdf", contentType: "application/pdf", content: "AAAA" }),
    }));
    expect(staffAttempt.status).toBe(403);
  });

  it("refuses a client document upload to a matter they weren't granted", async () => {
    const c2Cookie = await loginCookie("client2");
    const res = await fetch(`${baseUrl}/api/client-portal/matters/m1/documents`, withCookie(c2Cookie, {
      method: "POST",
      body: JSON.stringify({ fileName: "x.pdf", contentType: "application/pdf", content: "AAAA" }),
    }));
    expect(res.status).toBe(403);
  });

  it("reports the configured upload limit", async () => {
    const res = await get(clientCookie, "/api/client-portal/limits");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxUploadBytes: documents.getMaxUploadBytes() });
  });

  it("serves an invoice preview and PDF only once it's sent, never a draft", async () => {
    const attorneyActor = { id: "a1", role: "attorney" as const };
    const draft = invoicing.createDraft(attorneyActor, "m1", {});
    invoicing.addLineItem(attorneyActor, "m1", draft.id, {
      description: "Research",
      source: "flat",
      quantityMilli: 1000,
      unitAmountCents: 5_000,
    });

    const draftPreview = await get(clientCookie, `/api/client-portal/matters/m1/invoices/${draft.id}/preview`);
    expect(draftPreview.status).toBe(404);

    invoicing.send(attorneyActor, "m1", draft.id);
    const sentPreview = await get(clientCookie, `/api/client-portal/matters/m1/invoices/${draft.id}/preview`);
    expect(sentPreview.status).toBe(200);
    const body = (await sentPreview.json()) as { text: string };
    expect(body.text).toContain("Research");
  });

  it("404s the checkout-session route when invoicing isn't wired to the server", async () => {
    const attorneyActor = { id: "a1", role: "attorney" as const };
    const draft = invoicing.createDraft(attorneyActor, "m1", {});
    invoicing.addLineItem(attorneyActor, "m1", draft.id, { description: "Research", source: "flat", quantityMilli: 1000, unitAmountCents: 5_000 });
    invoicing.send(attorneyActor, "m1", draft.id);

    // The shared beforeEach server never passes `invoicing` to createReviewServer's options directly (only clientPortal holds an internal reference) — see "Stripe Checkout end to end" below for the fully wired path.
    const res = await fetch(`${baseUrl}/api/client-portal/matters/m1/invoices/${draft.id}/checkout-session`, withCookie(clientCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/);
  });

  it("grants and revokes client matter access through the Accounts routes", async () => {
    const clientUserId = (await (await get(attorneyCookie, "/api/accounts")).json()).find(
      (a: { username: string }) => a.username === "client2",
    ).id;

    const grant = await fetch(`${baseUrl}/api/accounts/${clientUserId}/grant-matter-access`, {
      method: "POST",
      ...withCookie(attorneyCookie, { body: JSON.stringify({ matterId: "m1" }) }),
    });
    expect(grant.status).toBe(200);
    expect((await grant.json()).clientMatterAccess).toEqual(["m1"]);

    const c2Cookie = await loginCookie("client2");
    expect((await get(c2Cookie, "/api/client-portal/matters/m1")).status).toBe(200);

    const revoke = await fetch(`${baseUrl}/api/accounts/${clientUserId}/revoke-matter-access`, {
      method: "POST",
      ...withCookie(attorneyCookie, { body: JSON.stringify({ matterId: "m1" }) }),
    });
    expect(revoke.status).toBe(200);
    expect((await get(c2Cookie, "/api/client-portal/matters/m1")).status).toBe(403);
  });

  it("refuses a non-attorney granting client matter access", async () => {
    const res = await fetch(`${baseUrl}/api/accounts/anyone/grant-matter-access`, {
      method: "POST",
      ...withCookie(clientCookie, { body: JSON.stringify({ matterId: "m1" }) }),
    });
    expect(res.status).toBe(403);
  });
});

describe("Stripe Checkout end to end (client portal + webhook)", () => {
  const WEBHOOK_SECRET = "whsec_test_secret";

  function fakeCheckoutProvider() {
    const sessions: Array<{ amountCents: number; metadata: Record<string, string> }> = [];
    return {
      name: "fake",
      sessions,
      async createSession(request: { amountCents: number; metadata: Record<string, string> }) {
        sessions.push({ amountCents: request.amountCents, metadata: request.metadata });
        return { id: `cs_${sessions.length}`, url: `https://checkout.example.com/cs_${sessions.length}` };
      },
    };
  }

  async function setup() {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "client1", password: "correct-horse", role: "client", actorId: "c1" });
    accessControl.grantClientAccess("c1", "m1");

    const invoiceStore = new InvoiceStore();
    const checkout = fakeCheckoutProvider();
    const invoicing = new InvoicingService({
      store: invoiceStore,
      accessControl,
      auditLog,
      trust: new TrustLedger(),
      billingHours: new BillingHoursStore(),
      processor: new ManualPaymentProcessor(),
      checkout,
      publicBaseUrl: "https://docket.example.com",
    });
    const matters = new MatterStore();
    matters.upsert("m1", { title: "State v. Ruiz", status: "open", parties: [] });
    const clientPortal = new ClientPortalService({ accessControl, matters, documents: new DocumentStore(), invoicing });

    const testServer = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      clientPortal,
      invoicing,
      stripeWebhook: { webhookSecret: WEBHOOK_SECRET },
    });
    await new Promise<void>((resolve) => testServer.listen(0, resolve));
    const url = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;

    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "client1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const draft = invoicing.createDraft({ id: "a1", role: "attorney" }, "m1", {});
    invoicing.addLineItem({ id: "a1", role: "attorney" }, "m1", draft.id, { description: "Research", source: "flat", quantityMilli: 1000, unitAmountCents: 5_000 });
    invoicing.send({ id: "a1", role: "attorney" }, "m1", draft.id);

    return { testServer, url, cookie, draft, invoicing, checkout };
  }

  it("creates a Checkout session and returns Stripe's own hosted URL", async () => {
    const { testServer, url, cookie, draft, checkout } = await setup();
    try {
      const res = await fetch(`${url}/api/client-portal/matters/m1/invoices/${draft.id}/checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://checkout.example.com/cs_1");
      expect(checkout.sessions[0]).toMatchObject({ amountCents: 5_000, metadata: { matterId: "m1", invoiceId: draft.id } });
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  it("rejects a webhook with no/invalid Stripe-Signature header", async () => {
    const { testServer, url, draft } = await setup();
    try {
      const rawBody = JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", payment_intent: "pi_1", amount_total: 5_000, metadata: { matterId: "m1", invoiceId: draft.id } } },
      });
      const res = await fetch(`${url}/api/stripe/webhook`, { method: "POST", body: rawBody });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  it("records the payment once a correctly signed webhook arrives, visible immediately to the client", async () => {
    const { createHmac } = await import("node:crypto");
    const { testServer, url, cookie, draft, invoicing } = await setup();
    try {
      const rawBody = JSON.stringify({
        type: "checkout.session.completed",
        data: { object: { id: "cs_1", payment_intent: "pi_1", amount_total: 5_000, metadata: { matterId: "m1", invoiceId: draft.id } } },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
      const res = await fetch(`${url}/api/stripe/webhook`, {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: rawBody,
      });
      expect(res.status).toBe(200);

      const view = invoicing.get({ id: "a1", role: "attorney" }, "m1", draft.id);
      expect(view.totals.balanceCents).toBe(0);

      const detail = await (
        await fetch(`${url}/api/client-portal/matters/m1`, { headers: { Cookie: cookie } })
      ).json();
      expect(detail.invoices[0].status).toBe("paid");
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  it("404s the webhook route when not configured", async () => {
    const auth = new AuthService();
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {});
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const bareUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    const res = await fetch(`${bareUrl}/api/stripe/webhook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });
});
