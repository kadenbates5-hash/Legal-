import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

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

  const documentsService = new DocumentsService({ accessControl, store: new DocumentStore() });
  server = createReviewServer(
    new ReviewGateService(new WorkProductStore()),
    auth,
    { documents: documentsService },
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

describe("documents HTTP API", () => {
  it("404s when documents isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noDocsServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noDocsServer.listen(0, resolve));
    const { port } = noDocsServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/documents/matters/m1`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noDocsServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/documents/matters/m1`);
    expect(res.status).toBe(401);
  });

  it("reports the configured max upload size", async () => {
    const res = await fetch(`${baseUrl}/api/documents/limits`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.maxUploadBytes).toBe("number");
    expect(body.maxUploadBytes).toBeGreaterThan(0);
  });

  it("uploads and lists a document on the paralegal's assigned matter", async () => {
    const uploadRes = await fetch(
      `${baseUrl}/api/documents/matters/m1`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "contract.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
      }),
    );
    expect(uploadRes.status).toBe(200);
    const uploaded = await uploadRes.json();
    expect(uploaded.fileName).toBe("contract.pdf");

    const listRes = await fetch(`${baseUrl}/api/documents/matters/m1`, withCookie(paralegalCookie));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);
  });

  it("denies uploading on a matter the paralegal isn't assigned to", async () => {
    const res = await fetch(
      `${baseUrl}/api/documents/matters/m2`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "x.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("denies receptionists entirely", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/documents/matters/m1`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("gets a document's content and deletes it", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/documents/matters/m1`,
        withCookie(paralegalCookie, {
          method: "POST",
          body: JSON.stringify({ fileName: "contract.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
        }),
      )
    ).json();

    const getRes = await fetch(`${baseUrl}/api/documents/matters/m1/${created.id}`, withCookie(paralegalCookie));
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).content).toBe("aGVsbG8=");

    const deleteRes = await fetch(`${baseUrl}/api/documents/matters/m1/${created.id}`, withCookie(paralegalCookie, { method: "DELETE" }));
    expect(deleteRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/documents/matters/m1`, withCookie(paralegalCookie));
    expect(await listRes.json()).toHaveLength(0);
  });

  it("returns 404 for an unknown document id on an accessible matter", async () => {
    const res = await fetch(`${baseUrl}/api/documents/matters/m1/nope`, withCookie(paralegalCookie));
    expect(res.status).toBe(404);
  });

  it("lets an attorney upload/read on any matter", async () => {
    const res = await fetch(
      `${baseUrl}/api/documents/matters/m999`,
      withCookie(attorneyCookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "x.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
