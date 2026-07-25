import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { StaffScheduleService } from "../src/review-ui/staff-schedule-service.js";
import { StaffScheduleStore } from "../src/core/staff-schedule.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
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
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  const staffSchedule = new StaffScheduleService(new StaffScheduleStore());
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { staffSchedule });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("staff schedule HTTP API", () => {
  it("404s when the staff schedule isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const noScheduleServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noScheduleServer.listen(0, resolve));
    const { port } = noScheduleServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/staff-schedule/date/2026-07-28`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noScheduleServer.close(() => resolve()));
  });

  it("lets a paralegal set their own entry and read it back", async () => {
    const setRes = await fetch(
      `${baseUrl}/api/staff-schedule/actor/p1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", status: "remote" }) }),
    );
    expect(setRes.status).toBe(200);
    const listRes = await fetch(`${baseUrl}/api/staff-schedule/actor/p1`, withCookie(paralegalCookie));
    const entries = await listRes.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("remote");
  });

  it("denies a paralegal setting another actor's entry", async () => {
    const res = await fetch(
      `${baseUrl}/api/staff-schedule/actor/a1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", status: "out" }) }),
    );
    expect(res.status).toBe(403);
  });

  it("lets an attorney set anyone's entry, and lists everyone's status for a date", async () => {
    await fetch(
      `${baseUrl}/api/staff-schedule/actor/a1`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", status: "in_office" }) }),
    );
    await fetch(
      `${baseUrl}/api/staff-schedule/actor/p1`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ date: "2026-07-28", status: "remote" }) }),
    );
    const res = await fetch(`${baseUrl}/api/staff-schedule/date/2026-07-28`, withCookie(paralegalCookie));
    const entries = await res.json();
    expect(entries.map((e: { actorId: string }) => e.actorId).sort()).toEqual(["a1", "p1"]);
  });
});
