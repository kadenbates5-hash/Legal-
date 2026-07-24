import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SchedulingService } from "../src/core/scheduling.js";
import type { FirmConfig } from "../src/config/firm-config.js";

let server: Server;
let baseUrl: string;
let scheduling: SchedulingService;

const receptionistHeaders = { "x-actor-id": "r1", "x-actor-role": "receptionist", "Content-Type": "application/json" };

function makeFirmConfig(): FirmConfig {
  return {
    firmName: "Test Firm",
    attorneys: [{ id: "a1", name: "Alice", practiceAreaIds: ["criminal-law"] }],
    businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
    branding: { tone: "warm", greeting: "Hi." },
    jurisdictionRecordingConsent: "one-party-consent",
  };
}

beforeEach(async () => {
  scheduling = new SchedulingService({ firmConfig: makeFirmConfig() });
  const service = new ReviewGateService(new WorkProductStore());
  server = createReviewServer(service, undefined, scheduling);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("appointments HTTP API", () => {
  it("404s when scheduling isn't configured on the server", async () => {
    const noSchedulingServer = createReviewServer(new ReviewGateService(new WorkProductStore()));
    await new Promise<void>((resolve) => noSchedulingServer.listen(0, resolve));
    const { port } = noSchedulingServer.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/appointments`, { headers: receptionistHeaders });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noSchedulingServer.close(() => resolve()));
  });

  it("books a consultation via POST", async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", practiceAreaId: "criminal-law" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("scheduled");
    expect(body.attorneyId).toBe("a1");
  });

  it("lists appointments filtered by matterId", async () => {
    await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
    });
    await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m2", startTime: "2026-08-01T16:00:00.000Z", attorneyId: "a1" }),
    });

    const res = await fetch(`${baseUrl}/api/appointments?matterId=m1`, { headers: receptionistHeaders });
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].matterId).toBe("m1");
  });

  it("gets a single appointment by id", async () => {
    const created = await (
      await fetch(`${baseUrl}/api/appointments`, {
        method: "POST",
        headers: receptionistHeaders,
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      })
    ).json();

    const res = await fetch(`${baseUrl}/api/appointments/${created.id}`, { headers: receptionistHeaders });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(created.id);
  });

  it("returns 404 for an unknown appointment id", async () => {
    const res = await fetch(`${baseUrl}/api/appointments/nope`, { headers: receptionistHeaders });
    expect(res.status).toBe(404);
  });

  it("reschedules an appointment", async () => {
    const created = await (
      await fetch(`${baseUrl}/api/appointments`, {
        method: "POST",
        headers: receptionistHeaders,
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      })
    ).json();

    const res = await fetch(`${baseUrl}/api/appointments/${created.id}/reschedule`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ newStartTime: "2026-08-02T15:00:00.000Z" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rescheduled");
    expect(body.startTime).toBe("2026-08-02T15:00:00.000Z");
  });

  it("returns 409 for a booking that overlaps an existing appointment", async () => {
    await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
    });
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m2", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
    });
    expect(res.status).toBe(409);
  });

  it("cancels an appointment with a reason", async () => {
    const created = await (
      await fetch(`${baseUrl}/api/appointments`, {
        method: "POST",
        headers: receptionistHeaders,
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      })
    ).json();

    const res = await fetch(`${baseUrl}/api/appointments/${created.id}/cancel`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ reason: "client rescheduled elsewhere" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("cancelled");
  });

  it("completes an appointment", async () => {
    const created = await (
      await fetch(`${baseUrl}/api/appointments`, {
        method: "POST",
        headers: receptionistHeaders,
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      })
    ).json();

    const res = await fetch(`${baseUrl}/api/appointments/${created.id}/complete`, {
      method: "POST",
      headers: receptionistHeaders,
      body: "{}",
    });
    expect((await res.json()).status).toBe("completed");
  });

  it("lists due reminders and lets them be marked sent", async () => {
    const created = await (
      await fetch(`${baseUrl}/api/appointments`, {
        method: "POST",
        headers: receptionistHeaders,
        body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
      })
    ).json();

    const dueRes = await fetch(`${baseUrl}/api/appointments/reminders/due`, { headers: receptionistHeaders });
    // Nothing is due yet since the appointment is in the future relative to "now" in this test run.
    expect(dueRes.status).toBe(200);
    expect(Array.isArray(await dueRes.json())).toBe(true);

    const reminderId = created.reminders[0].id;
    const markRes = await fetch(`${baseUrl}/api/appointments/${created.id}/reminders/${reminderId}`, {
      method: "POST",
      headers: receptionistHeaders,
      body: "{}",
    });
    expect(markRes.status).toBe(200);
    const updated = await markRes.json();
    expect(updated.reminders.find((r: { id: string }) => r.id === reminderId).sentAt).toBeTruthy();
  });

  it("fires onMutated on booking but not on plain reads", async () => {
    let mutationCount = 0;
    const hookServer = createReviewServer(
      new ReviewGateService(new WorkProductStore()),
      () => {
        mutationCount += 1;
      },
      scheduling,
    );
    await new Promise<void>((resolve) => hookServer.listen(0, resolve));
    const { port } = hookServer.address() as AddressInfo;
    const hookBaseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${hookBaseUrl}/api/appointments`, { headers: receptionistHeaders });
    expect(mutationCount).toBe(0);

    await fetch(`${hookBaseUrl}/api/appointments`, {
      method: "POST",
      headers: receptionistHeaders,
      body: JSON.stringify({ matterId: "m1", startTime: "2026-08-01T15:00:00.000Z", attorneyId: "a1" }),
    });
    expect(mutationCount).toBe(1);

    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });
});
