import { GoogleCalendarEventPublisher } from "./google-calendar.js";
import { PerAttorneyCalendarEventPublisher } from "./per-attorney-calendar-publisher.js";
import { AppointmentCalendarSync } from "./appointment-calendar-sync.js";
import type { CalendarEventPublisher } from "./calendar-event-publisher.js";

/**
 * Standalone entry point (`npm run sync:calendar:push`) for the outbound
 * direction — deliberately its own process, same reasoning as
 * `sync-calendar-deadlines.ts`: this pushes `Appointment`s to a calendar
 * on its own schedule, authenticating to Docket as an ordinary
 * `x-system-api-key` client rather than running inside the main server.
 *
 * Two modes, chosen by `GOOGLE_CALENDAR_PER_ATTORNEY`:
 *
 * - **Unset (default) — the original, firm-wide shared calendar.**
 *   Required env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL/
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (PEM; literal "\n" escapes are
 *   normalized)/GOOGLE_CALENDAR_ID (the calendar shared with the
 *   service account — may be the same calendar `sync:calendar` reads
 *   deadlines from, or a separate one).
 * - **`GOOGLE_CALENDAR_PER_ATTORNEY=true` — route each appointment to
 *   its own attorney's connected Google Calendar** (see
 *   `review-ui/calendar-connection-service.ts` and the Security
 *   panel's "Connect Google Calendar" card). The shared-calendar env
 *   vars above become optional in this mode: if set, an attorney who
 *   hasn't connected their own calendar falls back to the shared one;
 *   if unset, their appointments are simply reported as a failure
 *   (nowhere to push them) rather than silently skipped.
 *
 * Either way: DOCKET_BASE_URL/DOCKET_SYSTEM_API_KEY are always required.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sharedCalendarPublisher(): CalendarEventPublisher | undefined {
  const clientEmail = process.env["GOOGLE_SERVICE_ACCOUNT_EMAIL"];
  const privateKey = process.env["GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"];
  const calendarId = process.env["GOOGLE_CALENDAR_ID"];
  if (!clientEmail || !privateKey || !calendarId) return undefined;
  return new GoogleCalendarEventPublisher({
    credentials: { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") },
    calendarId,
  });
}

const docketBaseUrl = requireEnv("DOCKET_BASE_URL");
const systemApiKey = requireEnv("DOCKET_SYSTEM_API_KEY");

const fallbackPublisher = sharedCalendarPublisher();
const publisher: CalendarEventPublisher =
  process.env["GOOGLE_CALENDAR_PER_ATTORNEY"] === "true"
    ? new PerAttorneyCalendarEventPublisher({ docketBaseUrl, systemApiKey, ...(fallbackPublisher ? { fallback: fallbackPublisher } : {}) })
    : new GoogleCalendarEventPublisher({
        credentials: {
          clientEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
          privateKey: requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
        },
        calendarId: requireEnv("GOOGLE_CALENDAR_ID"),
      });

const sync = new AppointmentCalendarSync({ publisher, docketBaseUrl, systemApiKey });

const result = await sync.run();
console.log(`Pushed ${result.pushed} appointment(s), removed ${result.deleted} cancelled event(s) from Google Calendar.`);
if (result.failures.length > 0) {
  console.error(`${result.failures.length} appointment(s) failed to sync:`);
  for (const failure of result.failures) {
    console.error(`  appointment=${failure.appointmentId}: ${failure.error}`);
  }
  process.exitCode = 1;
}
