import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { PdfReportService } from "../src/review-ui/pdf-report-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { PdfTextExtractor } from "../src/integrations/pdf-text.js";
import type { PdfCondenser } from "../src/integrations/pdf-condenser.js";

class FakeExtractor implements PdfTextExtractor {
  async extractText() {
    return { text: "Extracted contract text.", pageCount: 2 };
  }
}

class FakeCondenser implements PdfCondenser {
  async condense(pdfBytes: Buffer) {
    const data = Buffer.from(pdfBytes.subarray(0, Math.max(1, Math.floor(pdfBytes.byteLength / 2))));
    return { data, originalBytes: pdfBytes.byteLength, condensedBytes: data.byteLength };
  }
}

let server: Server;
let baseUrl: string;
let paralegalCookie: string;
let documentId: string;

const samplePdfBase64 = Buffer.from("%PDF-1.4 fake pdf bytes for testing").toString("base64");

async function loginCookie(username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return setCookie.split(";")[0]!;
}

function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: cookie } };
}

beforeEach(async () => {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  const documents = new DocumentsService({ accessControl, store: new DocumentStore() });
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: new WorkProductStore() });
  const pdfReports = new PdfReportService({ documents, drafting, extractor: new FakeExtractor(), condenser: new FakeCondenser() });

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { documents, drafting, pdfReports });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");

  const uploadRes = await fetch(
    `${baseUrl}/api/documents/matters/m1`,
    withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ fileName: "contract.pdf", contentType: "application/pdf", content: samplePdfBase64 }) }),
  );
  documentId = (await uploadRes.json()).id;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PDF reports HTTP API", () => {
  it("404s when PDF reports aren't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noPdfServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noPdfServer.listen(0, resolve));
    const { port } = noPdfServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/pdf-reports/matters/m1/doc_1/draft-report`, withCookie(cookie, { method: "POST" }));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noPdfServer.close(() => resolve()));
  });

  it("drafts a report from an uploaded PDF", async () => {
    const res = await fetch(`${baseUrl}/api/pdf-reports/matters/m1/${documentId}/draft-report`, withCookie(paralegalCookie, { method: "POST" }));
    expect(res.status).toBe(200);
    const wp = await res.json();
    expect(wp.content).toContain("Extracted contract text.");
    expect(wp.flags).toContain("pdf_extraction_requires_attorney_verification");
  });

  it("condenses an uploaded PDF into a new document", async () => {
    const res = await fetch(`${baseUrl}/api/pdf-reports/matters/m1/${documentId}/condense`, withCookie(paralegalCookie, { method: "POST" }));
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.condensedDocument.fileName).toBe("contract (condensed).pdf");
    expect(result.condensedBytes).toBeLessThan(result.originalBytes);
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/pdf-reports/matters/m1/${documentId}/draft-report`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
