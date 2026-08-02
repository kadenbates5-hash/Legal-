import type { EmailSender } from "./email-sender.js";
import { assertSafeEmailAddress } from "./email-sender.js";

/**
 * The vendor integration `scheduling.ts` deliberately leaves out:
 * `SchedulingService.getDueReminders()` computes *when* a reminder is
 * due, but sending it needs an email transport, which is exactly the
 * kind of vendor choice core stays agnostic about (same reasoning as
 * `voice-agent.ts` staying vendor-agnostic for STT/TTS). Now that an
 * `EmailSender` already exists for invoicing, this closes that gap the
 * same way `AppointmentCalendarSync`/`CalendarDeadlineSync` do: a
 * standalone engine that reads from and writes back to Docket's own
 * HTTP API using the `x-system-api-key` credential, never a shortcut
 * straight into `SchedulingService`.
 */
export interface AppointmentReminderResult {
  sent: number;
  /** A due reminder with no client email on record for its matter — not a failure, just nothing to send. */
  skipped: number;
  failures: { appointmentId: string; reminderId: string; error: string }[];
}

interface DueReminderAppointment {
  id: string;
  matterId: string;
  attorneyId: string;
  type: "consultation" | "follow_up";
  startTime: string;
  durationMinutes: number;
  /** Only present when the system credential fetched this list — see server.ts's enrichment of this route. */
  recipientEmail?: string;
}

interface DueReminderEntry {
  appointment: DueReminderAppointment;
  reminder: { id: string; offsetMinutesBefore: number; dueAt: string; sentAt?: string };
}

const TYPE_LABEL: Record<DueReminderAppointment["type"], string> = {
  consultation: "consultation",
  follow_up: "follow-up appointment",
};

/**
 * Pure so the wording is unit-testable without a live Docket instance or
 * mail transport — the same reasoning `buildAppointmentEventBody()` and
 * `parseDeadlineEvent()` give for staying exported and standalone.
 */
export function renderReminderEmail(entry: DueReminderEntry, firmName: string): { subject: string; text: string } {
  const when = new Date(entry.appointment.startTime).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const label = TYPE_LABEL[entry.appointment.type];
  const subject = `Reminder: your ${label} with ${firmName} — ${when}`;
  const text = [
    "Hello,",
    "",
    `This is a reminder of your ${label} with ${firmName}, scheduled for ${when}.`,
    "",
    "If you need to reschedule or have any questions, please call our office — this message is a reminder only, not a way to reply and change the appointment.",
    "",
    `— ${firmName}`,
  ].join("\n");
  return { subject, text };
}

export class AppointmentReminderSender {
  #email: EmailSender;
  #docketBaseUrl: string;
  #systemApiKey: string;
  #firmName: string;

  constructor(params: { email: EmailSender; docketBaseUrl: string; systemApiKey: string; firmName?: string }) {
    this.#email = params.email;
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
    this.#firmName = params.firmName ?? "the firm";
  }

  async run(): Promise<AppointmentReminderResult> {
    const due = await this.#fetchDue();
    const result: AppointmentReminderResult = { sent: 0, skipped: 0, failures: [] };

    for (const entry of due) {
      try {
        const to = entry.appointment.recipientEmail;
        if (!to) {
          result.skipped++;
          continue;
        }
        const { subject, text } = renderReminderEmail(entry, this.#firmName);
        await this.#email.send({ to: assertSafeEmailAddress(to), subject, text });
        await this.#markSent(entry.appointment.id, entry.reminder.id);
        result.sent++;
      } catch (err) {
        result.failures.push({
          appointmentId: entry.appointment.id,
          reminderId: entry.reminder.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  async #fetchDue(): Promise<DueReminderEntry[]> {
    const res = await fetch(`${this.#docketBaseUrl}/api/appointments/reminders/due`, {
      headers: { "x-system-api-key": this.#systemApiKey },
    });
    if (!res.ok) {
      throw new Error(`fetching due reminders failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as DueReminderEntry[];
  }

  async #markSent(appointmentId: string, reminderId: string): Promise<void> {
    const res = await fetch(
      `${this.#docketBaseUrl}/api/appointments/${encodeURIComponent(appointmentId)}/reminders/${encodeURIComponent(reminderId)}`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-system-api-key": this.#systemApiKey }, body: "{}" },
    );
    if (!res.ok) {
      throw new Error(`marking reminder sent failed (${res.status}): ${await res.text()}`);
    }
  }
}
