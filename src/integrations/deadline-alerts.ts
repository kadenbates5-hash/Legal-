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
 * **Routed per responsible attorney**, now that `User.email` exists (see
 * `core/auth.ts`): each matter's `responsibleAttorneyId` resolves to a
 * staff email via `/api/deadlines/upcoming`'s system-only enrichment
 * (`responsibleAttorneyEmail`, same "enrichment lives in the route"
 * pattern as the appointment-reminders route's `recipientEmail`), and
 * that attorney gets exactly their own at-risk deadlines — not the
 * whole firm's. A deadline whose matter has no responsible attorney on
 * record, or whose responsible attorney has no email on file, falls
 * back to the optional `catchAllEmail` (a firm-wide distinction list
 * works fine there); with no catch-all configured, it's counted in
 * `skipped` rather than silently dropped or blocking every other
 * attorney's digest.
 *
 * Unlike appointment reminders, this has no "mark sent" state: every run
 * reflects current system state and is safe to resend on every scheduled
 * invocation (e.g. once a day) — a digest that silently stopped
 * mentioning a deadline just because a previous run already covered it
 * would defeat the point.
 */
export interface DeadlineAlertResult {
  /** How many separate digest emails actually went out (one per recipient, attorneys plus an optional catch-all). */
  sent: number;
  /** Deadlines with no responsible attorney on record, or whose attorney has no email on file, and no `catchAllEmail` configured to fall back to. */
  skipped: number;
  /** How many deadlines the run covered in total, whether or not each one ended up in a sent digest. */
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
  /** Only present when the system credential fetched this list and the matter's responsible attorney has an email on file — see server.ts's enrichment of this route. */
  responsibleAttorneyEmail?: string;
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
 * mail transport, same reasoning as `renderReminderEmail()`. Takes one
 * recipient's slice of deadlines — the caller decides the grouping.
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
  #catchAllEmail: string | undefined;
  #withinDays: number | undefined;

  constructor(params: {
    email: EmailSender;
    docketBaseUrl: string;
    systemApiKey: string;
    /** Falls back for a deadline with no resolvable responsible-attorney email. Optional — omit it to simply skip those instead. */
    catchAllEmail?: string;
    firmName?: string;
    withinDays?: number;
  }) {
    this.#email = params.email;
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
    this.#catchAllEmail = params.catchAllEmail;
    this.#firmName = params.firmName ?? "the firm";
    this.#withinDays = params.withinDays;
  }

  async run(): Promise<DeadlineAlertResult> {
    const deadlines = await this.#fetchUpcoming();
    const byRecipient = new Map<string, UpcomingDeadlineEntry[]>();
    let skipped = 0;

    for (const deadline of deadlines) {
      const recipient = deadline.responsibleAttorneyEmail ?? this.#catchAllEmail;
      if (!recipient) {
        skipped++;
        continue;
      }
      const group = byRecipient.get(recipient) ?? [];
      group.push(deadline);
      byRecipient.set(recipient, group);
    }

    let sent = 0;
    for (const [recipient, group] of byRecipient) {
      const { subject, text } = renderDeadlineDigest(group, this.#firmName);
      await this.#email.send({ to: assertSafeEmailAddress(recipient), subject, text });
      sent++;
    }

    return { sent, skipped, deadlineCount: deadlines.length };
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
