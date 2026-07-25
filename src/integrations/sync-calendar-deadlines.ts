import { GoogleCalendarEventsSource } from "./google-calendar.js";
import { CalendarDeadlineSync } from "./calendar-deadline-sync.js";

/**
 * Standalone entry point (`npm run sync:calendar`) — deliberately not part
 * of the main Docket server process, same reasoning as scheduling
 * reminders staying "for a host process to poll and actually send": this
 * is a vendor integration meant to run on its own schedule (e.g. a cron
 * job), authenticating to Docket as an ordinary `x-system-api-key` client.
 *
 * Required env vars:
 *  - GOOGLE_SERVICE_ACCOUNT_EMAIL
 *  - GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (PEM; literal "\n" escapes are normalized)
 *  - GOOGLE_CALENDAR_ID (the calendar shared with the service account)
 *  - DOCKET_BASE_URL (e.g. https://docket.example.com)
 *  - DOCKET_SYSTEM_API_KEY (see start.ts's boot log / CALENDAR_SYSTEM_API_KEY)
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const eventsSource = new GoogleCalendarEventsSource({
  credentials: {
    clientEmail: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
  },
  calendarId: requireEnv("GOOGLE_CALENDAR_ID"),
});

const sync = new CalendarDeadlineSync({
  eventsSource,
  docketBaseUrl: requireEnv("DOCKET_BASE_URL"),
  systemApiKey: requireEnv("DOCKET_SYSTEM_API_KEY"),
});

const result = await sync.run();
console.log(`Confirmed ${result.confirmed} deadline(s) from Google Calendar.`);
if (result.failures.length > 0) {
  console.error(`${result.failures.length} event(s) failed to confirm:`);
  for (const failure of result.failures) {
    console.error(`  matter=${failure.matterId} type=${failure.deadlineType} event=${failure.eventId}: ${failure.error}`);
  }
  process.exitCode = 1;
}
