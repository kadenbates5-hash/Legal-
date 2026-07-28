import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import { AppointmentCalendarSync } from "../src/integrations/appointment-calendar-sync.js";
import type { CalendarEventPublisher, CalendarEventDraft } from "../src/integrations/calendar-event-publisher.js";
import type { Actor } from "../src/core/types.js";

const SYSTEM_API_KEY = "test-system-key-1234567890";
const receptionist: Actor = { id: "r1", role: "receptionist" };

let server: Server;
let baseUrl: string;
let scheduling: SchedulingService;

function fakePublisher(): CalendarEventPublisher & { upserts: Array<{ appointmentId: string; existingEventId: string | undefined; draft: CalendarEventDraft }>; deletes: string[] } {
  const upserts: Array<{ appointmentId: string; existingEventId: string | undefined; draft: CalendarEventDraft }> = [];
  const deletes: string[] = [];
  let nextId = 1;
  return {
    upserts,
    deletes,
    async upsertEvent(appointmentId, existingEventId, draft) {
      upserts.push({ appointmentId, existingEventId, draft });
      return existingEventId ?? `gcal-${nextId++}`;
    },
    async deleteEvent(eventId) {
      deletes.push(eventId);
    },
  };
}

beforeEach(async () => {
  scheduling = new SchedulingService();
  const auth = new AuthService();
  auth.setSystemApiKey(SYSTEM_API_KEY);
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { scheduling });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("AppointmentCalendarSync", () => {
  it("pushes a new appointment and records the returned event id via the real Docket API", async () => {
    const appt = scheduling.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: new Date("2026-09-01T14:00:00Z"),
      attorneyId: "a1",
    });

    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    const result = await sync.run();

    expect(result).toEqual({ pushed: 1, deleted: 0, failures: [] });
    expect(publisher.upserts).toEqual([{ appointmentId: appt.id, existingEventId: undefined, draft: expect.objectContaining({ matterId: "m1" }) }]);
    expect(scheduling.get(appt.id)?.calendarSyncPending).toBe(false);
    expect(scheduling.get(appt.id)?.calendarEventId).toBe("gcal-1");
  });

  it("a second run with nothing changed pushes nothing", async () => {
    scheduling.scheduleConsultation(receptionist, { matterId: "m1", startTime: new Date("2026-09-01T14:00:00Z"), attorneyId: "a1" });
    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    await sync.run();

    const second = await sync.run();
    expect(second).toEqual({ pushed: 0, deleted: 0, failures: [] });
  });

  it("a reschedule after a sync updates the existing event rather than creating a new one", async () => {
    const appt = scheduling.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: new Date("2026-09-01T14:00:00Z"),
      attorneyId: "a1",
    });
    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    await sync.run();

    scheduling.reschedule(receptionist, appt.id, { newStartTime: new Date("2026-09-02T14:00:00Z") });
    const result = await sync.run();

    expect(result.pushed).toBe(1);
    expect(publisher.upserts[1]).toMatchObject({ appointmentId: appt.id, existingEventId: "gcal-1" });
    expect(scheduling.get(appt.id)?.calendarEventId).toBe("gcal-1");
  });

  it("cancelling a synced appointment deletes its event and clears the id", async () => {
    const appt = scheduling.scheduleConsultation(receptionist, { matterId: "m1", startTime: new Date("2026-09-01T14:00:00Z"), attorneyId: "a1" });
    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    await sync.run();

    scheduling.cancel(receptionist, appt.id);
    const result = await sync.run();

    expect(result).toEqual({ pushed: 0, deleted: 1, failures: [] });
    expect(publisher.deletes).toEqual(["gcal-1"]);
    expect(scheduling.get(appt.id)?.calendarEventId).toBeUndefined();
    expect(scheduling.get(appt.id)?.calendarSyncPending).toBe(false);
  });

  it("cancelling an appointment that was never synced records the cancellation without deleting anything", async () => {
    const appt = scheduling.scheduleConsultation(receptionist, { matterId: "m1", startTime: new Date("2026-09-01T14:00:00Z"), attorneyId: "a1" });
    scheduling.cancel(receptionist, appt.id);

    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    const result = await sync.run();

    expect(result).toEqual({ pushed: 0, deleted: 0, failures: [] });
    expect(publisher.deletes).toEqual([]);
    expect(scheduling.get(appt.id)?.calendarSyncPending).toBe(false);
  });

  it("records a failure per appointment rather than aborting the whole run", async () => {
    scheduling.scheduleConsultation(receptionist, { matterId: "m1", startTime: new Date("2026-09-01T14:00:00Z"), attorneyId: "a1" });
    const publisher: CalendarEventPublisher = {
      upsertEvent: async () => {
        throw new Error("vendor unreachable");
      },
      deleteEvent: async () => {},
    };
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    const result = await sync.run();

    expect(result.pushed).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("vendor unreachable");
  });

  it("rejects a wrong system key without pushing anything", async () => {
    scheduling.scheduleConsultation(receptionist, { matterId: "m1", startTime: new Date("2026-09-01T14:00:00Z"), attorneyId: "a1" });
    const publisher = fakePublisher();
    const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl: baseUrl, systemApiKey: "wrong-key" });
    await expect(sync.run()).rejects.toThrow(/401/);
    expect(publisher.upserts).toEqual([]);
  });
});
