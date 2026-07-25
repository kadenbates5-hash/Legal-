import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { AuthService } from "../src/core/auth.js";
import { CalendarDeadlineSync } from "../src/integrations/calendar-deadline-sync.js";
import type { CalendarEventsSource, CalendarDeadlineEvent } from "../src/integrations/calendar-events-source.js";

const SYSTEM_API_KEY = "test-system-key-1234567890";

let server: Server;
let baseUrl: string;
let deadlineTracker: DeadlineTracker;

function fakeSource(events: CalendarDeadlineEvent[]): CalendarEventsSource {
  return { listDeadlineEvents: async () => events };
}

beforeEach(async () => {
  deadlineTracker = new DeadlineTracker();
  const auth = new AuthService();
  auth.setSystemApiKey(SYSTEM_API_KEY);
  const service = new ReviewGateService(new WorkProductStore(), deadlineTracker);
  server = createReviewServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CalendarDeadlineSync", () => {
  it("confirms a deadline via the real Docket API using the system credential", async () => {
    deadlineTracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });

    const sync = new CalendarDeadlineSync({
      eventsSource: fakeSource([{ eventId: "evt_1", matterId: "m1", deadlineType: "speedy_trial", date: "2026-09-01" }]),
      docketBaseUrl: baseUrl,
      systemApiKey: SYSTEM_API_KEY,
    });

    const result = await sync.run();
    expect(result).toEqual({ confirmed: 1, failures: [] });
    expect(deadlineTracker.status("m1", "speedy_trial")).toMatchObject({ state: "confirmed", date: "2026-09-01" });
  });

  it("confirming a disagreeing date surfaces as a conflict, not a silent failure", async () => {
    deadlineTracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" });

    const sync = new CalendarDeadlineSync({
      eventsSource: fakeSource([{ eventId: "evt_1", matterId: "m1", deadlineType: "speedy_trial", date: "2026-09-15" }]),
      docketBaseUrl: baseUrl,
      systemApiKey: SYSTEM_API_KEY,
    });

    const result = await sync.run();
    expect(result.confirmed).toBe(1);
    expect(deadlineTracker.status("m1", "speedy_trial").state).toBe("conflict");
  });

  it("records a failure per event rather than aborting the whole run", async () => {
    const sync = new CalendarDeadlineSync({
      eventsSource: fakeSource([
        { eventId: "evt_1", matterId: "m1", deadlineType: "speedy_trial", date: "2026-09-01" },
        { eventId: "evt_2", matterId: "m2", deadlineType: "arraignment", date: "2026-09-02" },
      ]),
      docketBaseUrl: baseUrl,
      systemApiKey: "wrong-key",
    });

    const result = await sync.run();
    expect(result.confirmed).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ eventId: "evt_1", matterId: "m1" });
  });

  it("rejects the system key if it doesn't match, even for a well-formed event", async () => {
    const sync = new CalendarDeadlineSync({
      eventsSource: fakeSource([{ eventId: "evt_1", matterId: "m1", deadlineType: "speedy_trial", date: "2026-09-01" }]),
      docketBaseUrl: baseUrl,
      systemApiKey: "wrong-key",
    });

    const result = await sync.run();
    expect(result.confirmed).toBe(0);
    expect(result.failures[0]?.error).toMatch(/401/);
  });
});
