import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { PDFDocument } from "pdf-lib";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { ESignatureService } from "../src/review-ui/esignature-service.js";
import { ESignatureStore } from "../src/core/esignature.js";
import { DocumentStore } from "../src/core/document-store.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;
let documents: DocumentStore;

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

async function realPdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return Buffer.from(await doc.save()).toString("base64");
}

beforeEach(async () => {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  documents = new DocumentStore();
  const esignature = new ESignatureService({
    store: new ESignatureStore(),
    accessControl,
    auditLog,
    documents,
    workProducts: new WorkProductStore(),
    baseUrl: "https://docket.example.com",
  });

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { esignature, auditLog });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1");
  paralegalCookie = await loginCookie("paralegal1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("e-signature HTTP API", () => {
  it("404s when e-signature isn't configured on the server", async () => {
    const bareAuth = new AuthService();
    bareAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bare = createReviewServer(new ReviewGateService(new WorkProductStore()), bareAuth);
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/esignature/matters/m1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    // The public signer route needs no session at all, and 404s the same way.
    const signRes = await fetch(`${url}/api/sign/whatever`);
    expect(signRes.status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("drives the full staff-send -> public-sign -> staff-download flow", async () => {
    const doc = documents.upload({ matterId: "m1", fileName: "engagement.pdf", contentType: "application/pdf", content: await realPdfBase64(), uploadedBy: "p1" });

    const sendRes = await fetch(
      `${baseUrl}/api/esignature/matters/m1`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ title: "Engagement Letter", sourceKind: "document", sourceId: doc.id, signers: [{ name: "Jane Doe", email: "jane@example.com" }] }),
      }),
    );
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    const envelopeId = sendBody.envelope.id;
    const signerId = sendBody.envelope.signers[0].id;
    const signingUrl = sendBody.signingUrls[signerId];
    expect(signingUrl).toContain("https://docket.example.com/sign.html?token=");
    const token = new URL(signingUrl).searchParams.get("token");

    // The public signer endpoints need no cookie at all.
    const statusRes = await fetch(`${baseUrl}/api/sign/${token}`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.signerName).toBe("Jane Doe");
    expect(status.signerStatus).toBe("pending");

    const docRes = await fetch(`${baseUrl}/api/sign/${token}/document`);
    expect(docRes.status).toBe(200);
    expect(docRes.headers.get("content-type")).toBe("application/pdf");
    expect(docRes.headers.get("content-disposition")).toMatch(/^inline;/);

    const signRes = await fetch(`${baseUrl}/api/sign/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureText: "Jane Doe" }),
    });
    expect(signRes.status).toBe(200);

    // The token is single-use.
    const replay = await fetch(`${baseUrl}/api/sign/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureText: "Jane Doe" }),
    });
    expect(replay.status).toBe(404);

    const getRes = await fetch(`${baseUrl}/api/esignature/matters/m1/${envelopeId}`, withCookie(attorneyCookie));
    expect(getRes.status).toBe(200);
    const envelope = await getRes.json();
    expect(envelope.status).toBe("completed");

    const pdfRes = await fetch(`${baseUrl}/api/esignature/matters/m1/${envelopeId}/final-pdf`, withCookie(attorneyCookie));
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await pdfRes.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("denies a paralegal not assigned to the matter", async () => {
    const doc = documents.upload({ matterId: "m2", fileName: "x.pdf", contentType: "application/pdf", content: await realPdfBase64(), uploadedBy: "a1" });
    const res = await fetch(
      `${baseUrl}/api/esignature/matters/m2`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] }) }),
    );
    expect(res.status).toBe(403);
  });

  it("voiding is attorney-only", async () => {
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: await realPdfBase64(), uploadedBy: "p1" });
    const sendRes = await fetch(
      `${baseUrl}/api/esignature/matters/m1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] }) }),
    );
    const { envelope } = await sendRes.json();

    const deniedRes = await fetch(`${baseUrl}/api/esignature/matters/m1/${envelope.id}/void`, withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ reason: "nope" }) }));
    expect(deniedRes.status).toBe(403);

    const voidRes = await fetch(`${baseUrl}/api/esignature/matters/m1/${envelope.id}/void`, withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ reason: "withdrawn" }) }));
    expect(voidRes.status).toBe(200);
    const voided = await voidRes.json();
    expect(voided.status).toBe("voided");
  });

  it("requires a session for the staff-facing routes", async () => {
    const res = await fetch(`${baseUrl}/api/esignature/matters/m1`);
    expect(res.status).toBe(401);
  });
});
