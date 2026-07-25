import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AuditService } from "../src/review-ui/audit-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;

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
  auditLog.append({ actor: { id: "p1", role: "paralegal" }, matterId: "m1", action: "access_granted", detail: "category=case_file reason=ok" });
  auditLog.append({ actor: { id: "p1", role: "paralegal" }, matterId: "m2", action: "access_denied", detail: "category=case_file reason=different matter" });

  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  const audit = new AuditService(auditLog);
  server = createReviewServer(
    new ReviewGateService(new WorkProductStore()),
    auth,
    { audit },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("audit log HTTP API", () => {
  it("404s when the audit log isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const noAuditServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noAuditServer.listen(0, resolve));
    const { port } = noAuditServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/audit`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noAuditServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    expect(res.status).toBe(401);
  });

  it("denies non-attorney actors", async () => {
    const res = await fetch(`${baseUrl}/api/audit`, withCookie(paralegalCookie));
    expect(res.status).toBe(403);
  });

  it("lists all entries for an attorney", async () => {
    const res = await fetch(`${baseUrl}/api/audit`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
  });

  it("filters by matterId", async () => {
    const res = await fetch(`${baseUrl}/api/audit?matterId=m1`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    const entries = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].matterId).toBe("m1");
  });
});
