import { SmtpEmailSender } from "./smtp-email.js";
import { DeadlineAlertSender } from "./deadline-alerts.js";

/**
 * Standalone entry point (`npm run send:deadline-alerts`) — deliberately
 * its own process rather than running inside the main server, same
 * reasoning as `send-appointment-reminders.ts`: meant to run on its own
 * schedule (e.g. a daily cron job) against Docket's own API,
 * authenticating as an ordinary `x-system-api-key` client rather than
 * reaching into `ReviewGateService` directly.
 *
 * Required env vars:
 *  - SMTP_HOST / SMTP_FROM (plus optional SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_ALLOW_INSECURE)
 *  - DOCKET_BASE_URL
 *  - DOCKET_SYSTEM_API_KEY
 *  - DEADLINE_ALERT_RECIPIENT
 * Optional:
 *  - FIRM_NAME (used in the digest's subject/body; falls back to "the firm")
 *  - DEADLINE_ALERT_WITHIN_DAYS (falls back to the Deadlines panel's own default horizon)
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

const sender = new DeadlineAlertSender({
  email,
  docketBaseUrl: requireEnv("DOCKET_BASE_URL"),
  systemApiKey: requireEnv("DOCKET_SYSTEM_API_KEY"),
  recipientEmail: requireEnv("DEADLINE_ALERT_RECIPIENT"),
  ...(process.env["FIRM_NAME"] ? { firmName: process.env["FIRM_NAME"] } : {}),
  ...(process.env["DEADLINE_ALERT_WITHIN_DAYS"] ? { withinDays: Number(process.env["DEADLINE_ALERT_WITHIN_DAYS"]) } : {}),
});

const result = await sender.run();
if (result.sent) {
  console.log(`Sent a deadline-risk digest covering ${result.deadlineCount} deadline(s).`);
} else {
  console.log("No deadlines at risk — no digest sent.");
}
