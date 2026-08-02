import type { EmailSender } from "./email-sender.js";
import { assertSafeEmailAddress } from "./email-sender.js";

/**
 * The vendor integration `review-service.ts`/`deadline.ts` deliberately
 * leave out: `ReviewGateService.listUpcomingDeadlines()` already computes
 * the firm-wide, risk-ranked "Coming due" view the Deadlines panel shows
 * an attorney, but nobody sees it unless they happen to open the panel —
 * and per CLAUDE.md, "Missing a deadline is the most common malpractice
 * claim there is." This closes that gap the same way
 * `AppointmentReminderSender` closes the equivalent one for appointments:
 * a standalone engine that reads Docket's own HTTP API using the
 * `x-system-api-key` credential, never a shortcut straight into
 * `ReviewGateService`/`DeadlineTracker`.
 *
 * Deliberately a single firm-wide digest to one configured recipient,
 * not per-responsible-attorney routing — there is no email field on a
 * `User`/staff account yet, and adding one is a separate, larger change.
 * A firm can point `DEADLINE_ALERT_RECIPIENT` at a distribution list if
 * several people need it.
 *
 * Unlike appointment reminders, this has no "mark sent" state: every run
 * reflects current system state and is safe to resend on every scheduled
 * invocation (e.g. once a day) — a digest that silently stopped
 * mentioning a deadline just because a previous run already covered it
 * would defeat the point.
 */
export interface DeadlineAlertResult {
  /** True if an email was sent — false when nothing was at risk, so no digest is needed. */
  sent: boolean;
  /** How many deadlines the digest covered, whether or not an email was sent. */
  deadlineCount: number;
}

interface UpcomingDeadlineEntry {
  matterId: string;
  type: string;
  date: string;
  daysAway: number;
  confirmationState: "unconfirmed" | "confirmed" | "conflict";
  overdue: boolean;
  urgency: number;
}

const TYPE_LABEL: Record<string, string> = {
  speedy_trial: "speedy trial",
  arraignment: "arraignment",
  bail_hearing: "bail hearing",
  discovery_response: "discovery response",
  other: "deadline",
};

const STATE_LABEL: Record<UpcomingDeadlineEntry["confirmationState"], string> = {
  unconfirmed: "unconfirmed",
  confirmed: "confirmed",
  conflict: "CONFLICTING DATES",
};

function describeTiming(deadline: UpcomingDeadlineEntry): string {
  if (deadline.overdue) return `OVERDUE by ${Math.abs(deadline.daysAway)} day(s)`;
  if (deadline.daysAway === 0) return "due today";
  if (deadline.daysAway === 1) return "due tomorrow";
  return `due in ${deadline.daysAway} days`;
}

/**
 * Pure so the wording is unit-testable without a live Docket instance or
 * mail transport, same reasoning as `renderReminderEmail()`.
 */
export function renderDeadlineDigest(
  deadlines: UpcomingDeadlineEntry[],
  firmName: string,
): { subject: string; text: string } {
  const overdueCount = deadlines.filter((d) => d.overdue).length;
  const subject =
    overdueCount > 0
      ? `${firmName} deadline alert: ${overdueCount} overdue, ${deadlines.length} at risk`
      : `${firmName} deadline alert: ${deadlines.length} at risk`;

  const lines = [
    `${firmName} deadlines at risk, most urgent first:`,
    "",
    ...deadlines.map((d) => {
      const label = TYPE_LABEL[d.type] ?? d.type;
      return `- Matter ${d.matterId}: ${label} on ${d.date} (${describeTiming(d)}) — ${STATE_LABEL[d.confirmationState]}`;
    }),
    "",
    "This is an automated digest reflecting current system state — it is not a substitute for reviewing the Deadlines panel directly.",
    "",
    `— ${firmName}`,
  ];
  return { subject, text: lines.join("\n") };
}

export class DeadlineAlertSender {
  #email: EmailSender;
  #docketBaseUrl: string;
  #systemApiKey: string;
  #firmName: string;
  #recipientEmail: string;
  #withinDays: number | undefined;

  constructor(params: {
    email: EmailSender;
    docketBaseUrl: string;
    systemApiKey: string;
    recipientEmail: string;
    firmName?: string;
    withinDays?: number;
  }) {
    this.#email = params.email;
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
    this.#recipientEmail = params.recipientEmail;
    this.#firmName = params.firmName ?? "the firm";
    this.#withinDays = params.withinDays;
  }

  async run(): Promise<DeadlineAlertResult> {
    const deadlines = await this.#fetchUpcoming();
    if (deadlines.length === 0) {
      return { sent: false, deadlineCount: 0 };
    }
    const { subject, text } = renderDeadlineDigest(deadlines, this.#firmName);
    await this.#email.send({ to: assertSafeEmailAddress(this.#recipientEmail), subject, text });
    return { sent: true, deadlineCount: deadlines.length };
  }

  async #fetchUpcoming(): Promise<UpcomingDeadlineEntry[]> {
    const url = new URL(`${this.#docketBaseUrl}/api/deadlines/upcoming`);
    if (this.#withinDays !== undefined) {
      url.searchParams.set("withinDays", String(this.#withinDays));
    }
    const res = await fetch(url, { headers: { "x-system-api-key": this.#systemApiKey } });
    if (!res.ok) {
      throw new Error(`fetching upcoming deadlines failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as UpcomingDeadlineEntry[];
  }
}
