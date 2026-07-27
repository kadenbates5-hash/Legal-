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
