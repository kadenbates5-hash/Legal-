import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";

let server: Server;
let baseUrl: string;
let paralegalCookie: string;
let attorneyCookie: string;

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
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });

  const workProductStore = new WorkProductStore();
  const documentStore = new DocumentStore();
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: workProductStore });
  const documents = new DocumentsService({ accessControl, store: documentStore });
  const cases = new CasesService({ accessControl, workProductStore, documentStore });

  server = createReviewServer(
    new ReviewGateService(workProductStore),
    auth,
    { drafting, documents, cases },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("cases HTTP API", () => {
  it("404s when cases isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noCasesServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noCasesServer.listen(0, resolve));
    const { port } = noCasesServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/cases`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noCasesServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/cases`);
    expect(res.status).toBe(401);
  });

  it("lists cases visible to the caller", async () => {
    const res = await fetch(`${baseUrl}/api/cases`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    const cases = await res.json();
    expect(cases.map((c: { matterId: string }) => c.matterId)).toEqual(["m1"]);
  });

  it("combines a drafted work product and an uploaded document in one case's detail", async () => {
    await fetch(
      `${baseUrl}/api/drafting/matters/m1/draft-template`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ templateId: "engagement_letter", content: "x" }) }),
    );
    await fetch(
      `${baseUrl}/api/documents/matters/m1`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "contract.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
      }),
    );

    const res = await fetch(`${baseUrl}/api/cases/m1`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.workProducts).toHaveLength(1);
    expect(detail.documents).toHaveLength(1);
  });

  it("denies case detail on a matter the paralegal isn't assigned to", async () => {
    const res = await fetch(`${baseUrl}/api/cases/m999`, withCookie(paralegalCookie));
    expect(res.status).toBe(403);
  });

  it("an attorney sees a matter created only via drafting on another actor's behalf", async () => {
    await fetch(
      `${baseUrl}/api/drafting/matters/m999/draft-template`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ templateId: "engagement_letter", content: "x" }) }),
    );
    const res = await fetch(`${baseUrl}/api/cases`, withCookie(attorneyCookie));
    const cases = await res.json();
    expect(cases.map((c: { matterId: string }) => c.matterId)).toContain("m999");
  });
});
