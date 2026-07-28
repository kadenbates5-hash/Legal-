import { GoogleCalendarEventPublisher } from "./google-calendar.js";
import { AppointmentCalendarSync } from "./appointment-calendar-sync.js";

/**
 * Standalone entry point (`npm run sync:calendar:push`) for the outbound
 * direction — deliberately its own process, same reasoning as
 * `sync-calendar-deadlines.ts`: this pushes `Appointment`s to a shared
 * calendar on its own schedule, authenticating to Docket as an ordinary
 * `x-system-api-key` client rather than running inside the main server.
 *
 * Required env vars:
 *  - GOOGLE_SERVICE_ACCOUNT_EMAIL
 *  - GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (PEM; literal "\n" escapes are normalized)
 *  - GOOGLE_CALENDAR_ID (the calendar shared with the service account —
 *    may be the same calendar `sync:calendar` reads deadlines from, or a
 *    separate one; this project doesn't assume either way)
 *  - DOCKET_BASE_URL
 *  - DOCKET_SYSTEM_API_KEY
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const publisher = new GoogleCalendarEventPublisher({
  credentials: {
    clientEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
  },
  calendarId: requireEnv("GOOGLE_CALENDAR_ID"),
});

const sync = new AppointmentCalendarSync({
  publisher,
  docketBaseUrl: requireEnv("DOCKET_BASE_URL"),
  systemApiKey: requireEnv("DOCKET_SYSTEM_API_KEY"),
});

const result = await sync.run();
console.log(`Pushed ${result.pushed} appointment(s), removed ${result.deleted} cancelled event(s) from Google Calendar.`);
if (result.failures.length > 0) {
  console.error(`${result.failures.length} appointment(s) failed to sync:`);
  for (const failure of result.failures) {
    console.error(`  appointment=${failure.appointmentId}: ${failure.error}`);
  }
  process.exitCode = 1;
}
