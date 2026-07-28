import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import type { FirmConfig } from "../src/config/firm-config.js";

let server: Server;
let baseUrl: string;
let scheduling: SchedulingService;
let auth: AuthService;
let receptionistCookie: string;

function makeFirmConfig(): FirmConfig {
  return {
    firmName: "Test Firm",
    attorneys: [{ id: "a1", name: "Alice", practiceAreaIds: ["criminal-law"] }],
    businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
    branding: { tone: "warm", greeting: "Hi." },
    jurisdictionRecordingConsent: "one-party-consent",
  };
}

async function loginCookie(url: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/api/login`, {
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
  scheduling = new SchedulingService({ firmConfig: makeFirmConfig() });
  auth = new AuthService();
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
  const service = new ReviewGateService(new WorkProductStore());
  server = createReviewServer(service, auth, { scheduling });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  receptionistCookie = await loginCookie(baseUrl, "reception1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("appointments HTTP API", () => {
  it("404s when scheduling isn't configured on the server", async () => {
    const noSchedulingAuth = new AuthService();
    noSchedulingAuth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const noSchedulingServer = createReviewServer(new ReviewGateService(new WorkProductStore()), noSchedulingAuth);
    await new Promise<void>((resolve) => noSchedulingServer.listen(0, resolve));
    const { port } = noSchedulingServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const cookie = await loginCookie(url, "reception1", "correct-horse");
    const res = await fetch(`${url}/api/appointments`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noSchedulingServer.close(() => resolve()));
  });

  it("rejects appointment requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/appointments`);
    expect(res.status).toBe(401);
  });

  it("books a consultation via POST", async () => {
    const res = await fetch(
      `${baseUrl}/api/appointments`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", practiceAreaId: "criminal-law" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("scheduled");
    expect(body.attorneyId).toBe("a1");
  });

  it("lists appointments filtered by matterId", async () => {
    await fetch(
      `${baseUrl}/api/appointments`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      }),
    );
    await fetch(
      `${baseUrl}/api/appointments`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m2", startTime: "2026-08-01T16:00:00.000Z", attorneyId: "a1" }),
      }),
    );

    const res = await fetch(`${baseUrl}/api/appointments?matterId=m1`, withCookie(receptionistCookie));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].matterId).toBe("m1");
  });

  it("gets a single appointment by id", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/appointments`,
        withCookie(receptionistCookie, {
          method: "POST",
          body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
        }),
      )
    ).json();

    const res = await fetch(`${baseUrl}/api/appointments/${created.id}`, withCookie(receptionistCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(created.id);
  });

  it("returns 404 for an unknown appointment id", async () => {
    const res = await fetch(`${baseUrl}/api/appointments/nope`, withCookie(receptionistCookie));
    expect(res.status).toBe(404);
  });

  it("reschedules an appointment", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/appointments`,
        withCookie(receptionistCookie, {
          method: "POST",
          body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
        }),
      )
    ).json();

    const res = await fetch(
      `${baseUrl}/api/appointments/${created.id}/reschedule`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ newStartTime: "2026-08-02T15:00:00.000Z" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rescheduled");
    expect(body.startTime).toBe("2026-08-02T15:00:00.000Z");
  });

  it("returns 409 for a booking that overlaps an existing appointment", async () => {
    await fetch(
      `${baseUrl}/api/appointments`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      }),
    );
    const res = await fetch(
      `${baseUrl}/api/appointments`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m2", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("cancels an appointment with a reason", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/appointments`,
        withCookie(receptionistCookie, {
          method: "POST",
          body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
        }),
      )
    ).json();

    const res = await fetch(
      `${baseUrl}/api/appointments/${created.id}/cancel`,
      withCookie(receptionistCookie, {
        method: "POST",
        body: JSON.stringify({ reason: "client rescheduled elsewhere" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("cancelled");
  });

  it("completes an appointment", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/appointments`,
        withCookie(receptionistCookie, {
          method: "POST",
          body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
        }),
      )
    ).json();

    const res = await fetch(
      `${baseUrl}/api/appointments/${created.id}/complete`,
      withCookie(receptionistCookie, { method: "POST", body: "{}" }),
    );
    expect((await res.json()).status).toBe("completed");
  });

  it("lists due reminders and lets them be marked sent", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/appointments`,
        withCookie(receptionistCookie, {
          method: "POST",
          body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
        }),
      )
    ).json();

    const dueRes = await fetch(`${baseUrl}/api/appointments/reminders/due`, withCookie(receptionistCookie));
    // Nothing is due yet since the appointment is in the future relative to "now" in this test run.
    expect(dueRes.status).toBe(200);
    expect(Array.isArray(await dueRes.json())).toBe(true);

    const reminderId = created.reminders[0].id;
    const markRes = await fetch(
      `${baseUrl}/api/appointments/${created.id}/reminders/${reminderId}`,
      withCookie(receptionistCookie, { method: "POST", body: "{}" }),
    );
    expect(markRes.status).toBe(200);
    const updated = await markRes.json();
    expect(updated.reminders.find((r: { id: string }) => r.id === reminderId).sentAt).toBeTruthy();
  });

  it("fires onMutated on booking but not on plain reads", async () => {
    let mutationCount = 0;
    const hookAuth = new AuthService();
    hookAuth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const hookServer = createReviewServer(
      new ReviewGateService(new WorkProductStore()),
      hookAuth,
      {
        onMutated: () => {
          mutationCount += 1;
        },
        scheduling,
      },
    );
    await new Promise<void>((resolve) => hookServer.listen(0, resolve));
    const { port } = hookServer.address() as AddressInfo;
    const hookBaseUrl = `http://127.0.0.1:${port}`;
    const cookie = await loginCookie(hookBaseUrl, "reception1", "correct-horse");
    const mutationCountAfterLogin = mutationCount;

    await fetch(`${hookBaseUrl}/api/appointments`, withCookie(cookie));
    expect(mutationCount).toBe(mutationCountAfterLogin);

    await fetch(
      `${hookBaseUrl}/api/appointments`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      }),
    );
    expect(mutationCount).toBe(mutationCountAfterLogin + 1);

    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });

  it("filters to only appointments pending a calendar sync", async () => {
    const appt = scheduling.scheduleConsultation({ id: "r1", role: "receptionist" }, {
      matterId: "m1",
      startTime: new Date("2026-08-01T15:00:00Z"),
      attorneyId: "a1",
    });
    auth.setSystemApiKey("test-system-key-1234567890");
    scheduling.recordCalendarSync({ id: "sys", role: "system" }, appt.id, "gcal-1");

    const stillPending = scheduling.scheduleConsultation({ id: "r1", role: "receptionist" }, {
      matterId: "m1",
      startTime: new Date("2026-08-01T16:00:00Z"),
      attorneyId: "a1",
    });

    const res = await fetch(`${baseUrl}/api/appointments?pendingCalendarSync=true`, {
      headers: { "x-system-api-key": "test-system-key-1234567890" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((a) => a.id)).toEqual([stillPending.id]);
  });

  it("restricts recording a calendar sync to the system credential", async () => {
    const appt = scheduling.scheduleConsultation({ id: "r1", role: "receptionist" }, {
      matterId: "m1",
      startTime: new Date("2026-08-01T15:00:00Z"),
      attorneyId: "a1",
    });

    const denied = await fetch(
      `${baseUrl}/api/appointments/${appt.id}/calendar-sync`,
      withCookie(receptionistCookie, { method: "POST", body: JSON.stringify({ calendarEventId: "gcal-1" }) }),
    );
    expect(denied.status).toBe(403);

    auth.setSystemApiKey("test-system-key-1234567890");
    const allowed = await fetch(`${baseUrl}/api/appointments/${appt.id}/calendar-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": "test-system-key-1234567890" },
      body: JSON.stringify({ calendarEventId: "gcal-1" }),
    });
    expect(allowed.status).toBe(200);
    expect(scheduling.get({ id: "r1", role: "receptionist" }, appt.id)?.calendarEventId).toBe("gcal-1");
    expect(scheduling.get({ id: "r1", role: "receptionist" }, appt.id)?.calendarSyncPending).toBe(false);
  });
});
