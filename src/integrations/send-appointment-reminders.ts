import { SmtpEmailSender } from "./smtp-email.js";
import { AppointmentReminderSender } from "./appointment-reminders.js";

/**
 * Standalone entry point (`npm run send:reminders`) — deliberately its
 * own process rather than running inside the main server, same
 * reasoning as `sync-calendar-deadlines.ts`/`sync-appointments-to-calendar.ts`:
 * meant to run on its own schedule (e.g. a cron job hitting this every
 * few minutes) against Docket's own API, authenticating as an ordinary
 * `x-system-api-key` client rather than reaching into `SchedulingService`
 * directly.
 *
 * Required env vars:
 *  - SMTP_HOST / SMTP_FROM (plus optional SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_ALLOW_INSECURE)
 *  - DOCKET_BASE_URL
 *  - DOCKET_SYSTEM_API_KEY
 * Optional:
 *  - FIRM_NAME (used in the reminder's subject/body; falls back to "the firm")
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const email = new SmtpEmailSender({
  host: requireEnv("SMTP_HOST"),
  from: requireEnv("SMTP_FROM"),
  ...(process.env["SMTP_PORT"] ? { port: Number(process.env["SMTP_PORT"]) } : {}),
  ...(process.env["SMTP_USER"] ? { user: process.env["SMTP_USER"] } : {}),
  ...(process.env["SMTP_PASSWORD"] ? { password: process.env["SMTP_PASSWORD"] } : {}),
  ...(process.env["FIRM_NAME"] ? { fromName: process.env["FIRM_NAME"] } : {}),
  ...(process.env["SMTP_ALLOW_INSECURE"] === "true" ? { allowInsecurePlaintext: true } : {}),
});

const sender = new AppointmentReminderSender({
  email,
  docketBaseUrl: requireEnv("DOCKET_BASE_URL"),
  systemApiKey: requireEnv("DOCKET_SYSTEM_API_KEY"),
  ...(process.env["FIRM_NAME"] ? { firmName: process.env["FIRM_NAME"] } : {}),
});

const result = await sender.run();
console.log(`Sent ${result.sent} reminder(s), skipped ${result.skipped} with no client email on file.`);
if (result.failures.length > 0) {
  console.error(`${result.failures.length} reminder(s) failed to send:`);
  for (const failure of result.failures) {
    console.error(`  appointment=${failure.appointmentId} reminder=${failure.reminderId}: ${failure.error}`);
  }
  process.exitCode = 1;
}
