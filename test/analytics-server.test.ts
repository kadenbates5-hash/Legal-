import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import { MatterStore } from "../src/core/matters.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import { AnalyticsService } from "../src/review-ui/analytics-service.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;
let matters: MatterStore;

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
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  matters = new MatterStore();
  matters.upsert("m1", { title: "State v. Ruiz", responsibleAttorneyId: "a1", status: "open" });
  matters.upsert("m2", { title: "Closed matter", responsibleAttorneyId: "a1", status: "closed" });

  const analytics = new AnalyticsService({
    matters,
    invoices: new InvoiceStore(),
    billingHours: new BillingHoursStore(),
    utilization: new UtilizationTracker(),
    auth,
  });

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { analytics });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("analytics HTTP API", () => {
  it("404s when analytics isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const bareUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    const loginRes = await fetch(`${bareUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${bareUrl}/api/analytics/caseload`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it("returns caseload by attorney for an attorney", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/caseload`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.find((r: { actorId: string }) => r.actorId === "a1")).toMatchObject({ openMatters: 1, closedMatters: 1 });
  });

  it("returns matter-status counts", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/matter-status`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prospective: 0, open: 1, closed: 1 });
  });

  it("returns invoice-aging buckets", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/invoice-aging`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(5);
    expect(body.every((b: { count: number }) => b.count === 0)).toBe(true);
  });

  it("returns utilization-trend and billable-hours-trend as empty lists with no data", async () => {
    const util = await fetch(`${baseUrl}/api/analytics/utilization-trend`, withCookie(attorneyCookie));
    expect(util.status).toBe(200);
    expect(await util.json()).toEqual([]);

    const hours = await fetch(`${baseUrl}/api/analytics/billable-hours-trend`, withCookie(attorneyCookie));
    expect(hours.status).toBe(200);
    expect(await hours.json()).toEqual([]);
  });

  it("denies a paralegal actor with 403 on every analytics route", async () => {
    for (const path of ["caseload", "matter-status", "invoice-aging", "utilization-trend", "billable-hours-trend"]) {
      const res = await fetch(`${baseUrl}/api/analytics/${path}`, withCookie(paralegalCookie));
      expect(res.status).toBe(403);
    }
  });

  it("404s for an unknown analytics sub-path", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/not-a-real-report`, withCookie(attorneyCookie));
    expect(res.status).toBe(404);
  });
});
