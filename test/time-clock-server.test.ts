import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { TimeClockService } from "../src/review-ui/time-clock-service.js";
import { TimeClock } from "../src/core/time-clock.js";
import { PayrollStore } from "../src/core/payroll.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;
let clock: TimeClock;
let payroll: PayrollStore;

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

const post = (cookie: string, path: string, body: unknown = {}) =>
  fetch(`${baseUrl}${path}`, withCookie(cookie, { method: "POST", body: JSON.stringify(body) }));
const get = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, withCookie(cookie));

beforeEach(async () => {
  const auditLog = new AuditLog();
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  clock = new TimeClock();
  payroll = new PayrollStore();
  const timeClock = new TimeClockService({ clock, payroll, auditLog, defaultTimeZone: "America/New_York" });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { timeClock, auditLog });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1");
  paralegalCookie = await loginCookie("paralegal1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("time clock HTTP API", () => {
  it("404s when the time clock isn't configured", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bare = createReviewServer(new ReviewGateService(new WorkProductStore()), auth);
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/time-clock/clock-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("requires a session", async () => {
    const res = await fetch(`${baseUrl}/api/time-clock/clock-in`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("punches in and out, and reports a summary in the firm's timezone", async () => {
    expect((await post(paralegalCookie, "/api/time-clock/clock-in", { note: "courthouse" })).status).toBe(200);
    const summary = await (await get(paralegalCookie, "/api/time-clock/actor/p1/summary")).json();
    expect(summary.timeZone).toBe("America/New_York");
    expect(summary.openShift.note).toBe("courthouse");

    expect((await post(paralegalCookie, "/api/time-clock/clock-out")).status).toBe(200);
    const after = await (await get(paralegalCookie, "/api/time-clock/actor/p1/summary")).json();
    expect(after.openShift).toBeUndefined();
    expect(after.today.shiftCount).toBe(1);
  });

  it("409s on a double clock-in and on a clock-out with no shift open", async () => {
    await post(paralegalCookie, "/api/time-clock/clock-in");
    expect((await post(paralegalCookie, "/api/time-clock/clock-in")).status).toBe(409);
    await post(paralegalCookie, "/api/time-clock/clock-out");
    expect((await post(paralegalCookie, "/api/time-clock/clock-out")).status).toBe(409);
  });

  it("punches only the caller's own clock, whatever body is sent", async () => {
    // There is deliberately no actorId parameter on the punch routes.
    await post(paralegalCookie, "/api/time-clock/clock-in", { actorId: "a1" });
    expect(clock.openShift("p1")).toBeDefined();
    expect(clock.openShift("a1")).toBeUndefined();
  });

  it("403s a paralegal reading a colleague's timesheet, and lets an attorney read it", async () => {
    await post(paralegalCookie, "/api/time-clock/clock-in");
    expect((await get(paralegalCookie, "/api/time-clock/actor/a1/shifts")).status).toBe(403);
    expect((await get(attorneyCookie, "/api/time-clock/actor/p1/shifts")).status).toBe(200);
    expect((await get(paralegalCookie, "/api/time-clock/on-the-clock")).status).toBe(403);
    expect((await (await get(attorneyCookie, "/api/time-clock/on-the-clock")).json())).toHaveLength(1);
  });

  it("rejects an unknown totals bucket and an unknown timezone", async () => {
    expect((await get(paralegalCookie, "/api/time-clock/actor/p1/totals?kind=fortnight")).status).toBe(400);
    expect((await get(paralegalCookie, "/api/time-clock/actor/p1/totals?kind=day&tz=Mars/Olympus")).status).toBe(400);
  });

  it("keeps corrections attorney-only and requires a reason", async () => {
    const shift = await (await post(paralegalCookie, "/api/time-clock/clock-in")).json();
    expect(
      (await post(paralegalCookie, `/api/time-clock/shifts/${shift.id}/adjust`, {
        clockOutAt: "2026-07-20T21:00:00Z",
        reason: "forgot",
      })).status,
    ).toBe(403);
    expect(
      (await post(attorneyCookie, `/api/time-clock/shifts/${shift.id}/adjust`, { clockOutAt: "2026-07-20T21:00:00Z" }))
        .status,
    ).toBe(400);
    expect((await post(attorneyCookie, "/api/time-clock/shifts/shift_999/adjust", { reason: "x" })).status).toBe(404);
  });

  it("posts a completed shift to payroll exactly once", async () => {
    await post(paralegalCookie, "/api/time-clock/clock-in");
    const shift = await (await post(paralegalCookie, "/api/time-clock/clock-out")).json();

    // Punched in and straight back out: too short to be worth anything,
    // and rejected with a message about the punch rather than about
    // payroll's internal units.
    const tooShort = await post(attorneyCookie, `/api/time-clock/shifts/${shift.id}/post-to-payroll`);
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toMatch(/shorter than a minute/i);

    await post(attorneyCookie, `/api/time-clock/shifts/${shift.id}/adjust`, {
      clockInAt: "2026-07-20T13:00:00Z",
      clockOutAt: "2026-07-20T20:30:00Z",
      reason: "recording a real 7.5h day",
    });

    expect((await post(paralegalCookie, `/api/time-clock/shifts/${shift.id}/post-to-payroll`)).status).toBe(403);
    expect((await post(attorneyCookie, `/api/time-clock/shifts/${shift.id}/post-to-payroll`)).status).toBe(200);
    expect((await post(attorneyCookie, `/api/time-clock/shifts/${shift.id}/post-to-payroll`)).status).toBe(409);
    expect(payroll.listHours("p1")).toHaveLength(1);
  });
});
