import type { CalendarEventDraft, CalendarEventPublisher } from "./calendar-event-publisher.js";
import { buildAppointmentEventBody } from "./google-calendar.js";

/**
 * The per-attorney counterpart to `GoogleCalendarEventPublisher`'s
 * single shared service-account calendar. Routes each appointment to
 * its own `attorneyId`'s connected Google Calendar (see
 * `review-ui/calendar-connection-service.ts`) instead of one calendar
 * the whole firm shares.
 *
 * **Never holds a refresh token.** This runs in the same standalone
 * process as every other sync engine here (`AppointmentCalendarSync`,
 * `CalendarDeadlineSync`) — it reads from and writes to Docket's own
 * HTTP API using the `x-system-api-key` credential, never a shortcut
 * into core. For *access*, that means something stronger than the
 * usual "never a shortcut" reasoning: it resolves a fresh, short-lived
 * access token per attorney via `GET /api/calendar-connection/actor/
 * :id/token` (system-only — see `CalendarConnectionService
 * .accessTokenFor()`), and the long-lived refresh token that call
 * resolves from never leaves the main server process at all. An
 * external integration process compromised or logged carelessly can
 * at worst leak an hour of calendar access, not a standing credential.
 *
 * `fallback`, if given, is used for an attorney with no connection of
 * their own — typically the existing shared-service-account
 * `GoogleCalendarEventPublisher`, so a firm migrating to per-attorney
 * calendars doesn't lose sync for whoever hasn't connected yet. With
 * no fallback, an unconnected attorney's appointment is a recorded
 * failure on `upsertEvent` (there's genuinely nowhere to push it) and
 * a silent no-op on `deleteEvent` (nothing to delete against is the
 * same outcome "already gone" already gets).
 */
export class PerAttorneyCalendarEventPublisher implements CalendarEventPublisher {
  #docketBaseUrl: string;
  #systemApiKey: string;
  #fallback: CalendarEventPublisher | undefined;

  constructor(params: { docketBaseUrl: string; systemApiKey: string; fallback?: CalendarEventPublisher }) {
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
    this.#fallback = params.fallback;
  }

  async upsertEvent(appointmentId: string, existingEventId: string | undefined, draft: CalendarEventDraft): Promise<string> {
    const token = await this.#accessTokenFor(draft.attorneyId);
    if (!token) {
      if (this.#fallback) return this.#fallback.upsertEvent(appointmentId, existingEventId, draft);
      throw new Error(`attorney '${draft.attorneyId}' has no connected Google Calendar, and no shared calendar is configured as a fallback`);
    }

    const body = buildAppointmentEventBody(appointmentId, draft);
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    const url = existingEventId ? `${base}/${encodeURIComponent(existingEventId)}` : base;
    const res = await fetch(url, {
      method: existingEventId ? "PATCH" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Google Calendar event ${existingEventId ? "update" : "create"} failed (${res.status}): ${await res.text()}`);
    }
    const created = (await res.json()) as { id: string };
    return created.id;
  }

  async deleteEvent(eventId: string, attorneyId: string): Promise<void> {
    const token = await this.#accessTokenFor(attorneyId);
    if (!token) {
      if (this.#fallback) return this.#fallback.deleteEvent(eventId, attorneyId);
      return;
    }
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google Calendar event delete failed (${res.status}): ${await res.text()}`);
    }
  }

  async #accessTokenFor(attorneyId: string): Promise<string | undefined> {
    const res = await fetch(`${this.#docketBaseUrl}/api/calendar-connection/actor/${encodeURIComponent(attorneyId)}/token`, {
      headers: { "x-system-api-key": this.#systemApiKey },
    });
    if (!res.ok) {
      throw new Error(`resolving a calendar access token failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { connected: boolean; accessToken?: string };
    return body.connected ? body.accessToken : undefined;
  }
}
