import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { BillingHoursService } from "../src/review-ui/billing-hours-service.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
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
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });

  const billingHours = new BillingHoursService({ accessControl, store: new BillingHoursStore() });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { billingHours });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("billing hours HTTP API", () => {
  it("404s when billing hours aren't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const noBillingServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noBillingServer.listen(0, resolve));
    const { port } = noBillingServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/billing-hours/mine`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noBillingServer.close(() => resolve()));
  });

  it("logs and lists hours on the paralegal's assigned matter", async () => {
    const logRes = await fetch(
      `${baseUrl}/api/billing-hours/matters/m1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", hours: 2, description: "Discovery review" }) }),
    );
    expect(logRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/billing-hours/matters/m1`, withCookie(paralegalCookie));
    expect(await listRes.json()).toHaveLength(1);
  });

  it("denies logging hours on a matter the paralegal isn't assigned to", async () => {
    const res = await fetch(
      `${baseUrl}/api/billing-hours/matters/m2`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", hours: 1, description: "x" }) }),
    );
    expect(res.status).toBe(403);
  });

  it("lists an actor's own hours across matters via /mine", async () => {
    await fetch(
      `${baseUrl}/api/billing-hours/matters/m1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", hours: 1, description: "a" }) }),
    );
    const res = await fetch(`${baseUrl}/api/billing-hours/mine`, withCookie(paralegalCookie));
    expect(await res.json()).toHaveLength(1);
  });

  it("lets an attorney log and delete on any matter", async () => {
    const logRes = await fetch(
      `${baseUrl}/api/billing-hours/matters/m999`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", hours: 1, description: "Client call" }) }),
    );
    const entry = await logRes.json();

    const deleteRes = await fetch(`${baseUrl}/api/billing-hours/matters/m999/${entry.id}`, withCookie(attorneyCookie, { method: "DELETE" }));
    expect(deleteRes.status).toBe(200);
  });
});
