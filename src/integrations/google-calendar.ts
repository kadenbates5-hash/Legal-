import { createSign } from "node:crypto";
import type { DeadlineType } from "../core/deadline.js";
import type { CalendarDeadlineEvent, CalendarEventsSource } from "./calendar-events-source.js";
import type { CalendarEventDraft, CalendarEventPublisher } from "./calendar-event-publisher.js";

/**
 * Real Google Calendar implementation of `CalendarEventsSource`, read-only
 * against a single shared calendar (the firm shares a court-dates calendar
 * with the service account's own email — no domain-wide delegation, no
 * per-attorney OAuth, so setup is "share a calendar" rather than a Google
 * Workspace admin console flow).
 *
 * Deliberately hand-rolled (service-account JWT bearer flow via
 * `node:crypto` + `fetch`) rather than pulling in `googleapis`/
 * `google-auth-library` — same dependency-light approach as the rest of
 * this project (`server.ts` is dependency-free; `pg` was the one
 * justified exception).
 *
 * A deadline event must carry `matterId`/`deadlineType` in its
 * `extendedProperties.private` fields (Google Calendar's mechanism for
 * app-specific structured data on an event) — free-text titles/
 * descriptions are deliberately not parsed, since guessing wrong here
 * would mean confirming the wrong deadline.
 *
 * §5's due-diligence checklist (zero-retention, no training on firm data,
 * storage jurisdiction, subpoena risk, encryption) is a decision for the
 * firm to make about Google Calendar specifically before real court dates
 * go on the shared calendar — this class doesn't complete that review,
 * it's the technical integration once the vendor is chosen.
 */
const DEADLINE_TYPES: readonly DeadlineType[] = ["speedy_trial", "arraignment", "bail_hearing", "discovery_response", "other"];

function isDeadlineType(value: unknown): value is DeadlineType {
  return typeof value === "string" && (DEADLINE_TYPES as readonly string[]).includes(value);
}

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  /** PEM-encoded private key. Env vars commonly escape newlines as literal "\n" — normalize before passing in. */
  privateKey: string;
}

async function fetchAccessToken(credentials: GoogleServiceAccountCredentials, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(credentials.privateKey));
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token request failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Google token response did not include an access_token");
  }
  return body.access_token;
}

interface GoogleCalendarApiEvent {
  id: string;
  start?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendarEventsSource implements CalendarEventsSource {
  #credentials: GoogleServiceAccountCredentials;
  #calendarId: string;

  constructor(params: { credentials: GoogleServiceAccountCredentials; calendarId: string }) {
    this.#credentials = params.credentials;
    this.#calendarId = params.calendarId;
  }

  async listDeadlineEvents(): Promise<CalendarDeadlineEvent[]> {
    const token = await fetchAccessToken(this.#credentials, "https://www.googleapis.com/auth/calendar.readonly");
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.#calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("privateExtendedProperty", "docketDeadline=true");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Google Calendar events request failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { items?: GoogleCalendarApiEvent[] };
    const events: CalendarDeadlineEvent[] = [];
    for (const item of body.items ?? []) {
      const parsed = parseDeadlineEvent(item);
      if (parsed) events.push(parsed);
    }
    return events;
  }
}

/** Exported for testing without a live Google Calendar — the parsing rules are the part actually worth unit-testing. */
export function parseDeadlineEvent(item: GoogleCalendarApiEvent): CalendarDeadlineEvent | undefined {
  const props = item.extendedProperties?.private;
  const matterId = props?.["matterId"];
  const deadlineType = props?.["deadlineType"];
  const date = item.start?.date ?? item.start?.dateTime?.slice(0, 10);
  if (!matterId || !isDeadlineType(deadlineType) || !date) return undefined;
  return { eventId: item.id, matterId, deadlineType, date };
}

const APPOINTMENT_TYPE_LABEL: Record<CalendarEventDraft["type"], string> = {
  consultation: "Consultation",
  follow_up: "Follow-up",
};

/**
 * Exported for testing without a live Google Calendar — the event-shape
 * rules are the part actually worth unit-testing, the same reasoning
 * `parseDeadlineEvent` gives on the read side. Structured data
 * (`extendedProperties.private`), not the free-text summary, is what a
 * future read would key on if one is ever added, kept consistent here
 * even though nothing reads these back today.
 */
export function buildAppointmentEventBody(appointmentId: string, draft: CalendarEventDraft) {
  const start = new Date(draft.startTime);
  const end = new Date(start.getTime() + draft.durationMinutes * 60_000);
  return {
    summary: `${APPOINTMENT_TYPE_LABEL[draft.type]} — matter ${draft.matterId}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: {
      private: { docketAppointment: "true", appointmentId, matterId: draft.matterId, attorneyId: draft.attorneyId, type: draft.type },
    },
  };
}

/** Same JWT/event-shape approach as `GoogleCalendarEventsSource`, in the write direction: pushes `Appointment`s out rather than reading deadline confirmations in. */
export class GoogleCalendarEventPublisher implements CalendarEventPublisher {
  #credentials: GoogleServiceAccountCredentials;
  #calendarId: string;

  constructor(params: { credentials: GoogleServiceAccountCredentials; calendarId: string }) {
    this.#credentials = params.credentials;
    this.#calendarId = params.calendarId;
  }

  async upsertEvent(appointmentId: string, existingEventId: string | undefined, draft: CalendarEventDraft): Promise<string> {
    const token = await fetchAccessToken(this.#credentials, "https://www.googleapis.com/auth/calendar.events");
    const body = buildAppointmentEventBody(appointmentId, draft);

    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.#calendarId)}/events`;
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

  async deleteEvent(eventId: string): Promise<void> {
    const token = await fetchAccessToken(this.#credentials, "https://www.googleapis.com/auth/calendar.events");
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.#calendarId)}/events/${encodeURIComponent(eventId)}`;
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    // 404/410 means it's already gone — deleting an already-deleted event
    // isn't a failure, it's exactly what the caller wanted.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google Calendar event delete failed (${res.status}): ${await res.text()}`);
    }
  }
}
