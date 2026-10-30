import { afterEach, describe, expect, it, vi } from "vitest";
import { PerAttorneyCalendarEventPublisher } from "../src/integrations/per-attorney-calendar-publisher.js";
import type { CalendarEventDraft, CalendarEventPublisher } from "../src/integrations/calendar-event-publisher.js";

const draft: CalendarEventDraft = {
  matterId: "m1",
  attorneyId: "a1",
  type: "consultation",
  startTime: "2026-09-01T14:00:00Z",
  durationMinutes: 30,
};

const SYSTEM_API_KEY = "test-key";
const DOCKET_BASE_URL = "https://docket.example.com";

function fakeFallback(): CalendarEventPublisher & { upserts: number; deletes: number } {
  const state = { upserts: 0, deletes: 0 };
  return {
    get upserts() {
      return state.upserts;
    },
    get deletes() {
      return state.deletes;
    },
    async upsertEvent() {
      state.upserts++;
      return "fallback-event-id";
    },
    async deleteEvent() {
      state.deletes++;
    },
  };
}

describe("PerAttorneyCalendarEventPublisher", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pushes to the attorney's own primary calendar when connected", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/calendar-connection/actor/")) {
        return new Response(JSON.stringify({ connected: true, accessToken: "attorney-access-token" }), { status: 200 });
      }
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
      return new Response(JSON.stringify({ id: "gcal-event-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY });
    const eventId = await publisher.upsertEvent("appt1", undefined, draft);

    expect(eventId).toBe("gcal-event-1");
    expect(capturedUrl).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(capturedAuth).toBe("Bearer attorney-access-token");
  });

  it("falls back to the shared publisher for an attorney with no connection", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("/api/calendar-connection/actor/")) {
        return new Response(JSON.stringify({ connected: false }), { status: 200 });
      }
      throw new Error("should not call the Google Calendar API directly when falling back");
    }) as unknown as typeof fetch;

    const fallback = fakeFallback();
    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY, fallback });
    const eventId = await publisher.upsertEvent("appt1", undefined, draft);

    expect(eventId).toBe("fallback-event-id");
    expect(fallback.upserts).toBe(1);
  });

  it("throws for an unconnected attorney with no fallback configured", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })) as unknown as typeof fetch;
    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY });
    await expect(publisher.upsertEvent("appt1", undefined, draft)).rejects.toThrow(/no connected Google Calendar/);
  });

  it("deletes against the attorney's own calendar when connected", async () => {
    let deleteUrl: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/calendar-connection/actor/")) {
        return new Response(JSON.stringify({ connected: true, accessToken: "attorney-access-token" }), { status: 200 });
      }
      deleteUrl = url;
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY });
    await publisher.deleteEvent("gcal-event-1", "a1");
    expect(deleteUrl).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/gcal-event-1");
  });

  it("falls back to the shared publisher's delete for an unconnected attorney", async () => {
    global.fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ connected: false }), { status: 200 })) as unknown as typeof fetch;
    const fallback = fakeFallback();
    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY, fallback });
    await publisher.deleteEvent("gcal-event-1", "a1");
    expect(fallback.deletes).toBe(1);
  });

  it("silently no-ops deleting for an unconnected attorney with no fallback — nothing to delete against", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })) as unknown as typeof fetch;
    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY });
    await expect(publisher.deleteEvent("gcal-event-1", "a1")).resolves.toBeUndefined();
  });

  it("throws if resolving the access token itself fails", async () => {
    global.fetch = vi.fn(async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const publisher = new PerAttorneyCalendarEventPublisher({ docketBaseUrl: DOCKET_BASE_URL, systemApiKey: SYSTEM_API_KEY });
    await expect(publisher.upsertEvent("appt1", undefined, draft)).rejects.toThrow(/resolving a calendar access token failed/);
  });
});
