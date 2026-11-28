import { createHash } from "node:crypto";
import { dayOf, todayIn } from "../core/calendar-date.js";
import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditLog } from "../core/audit.js";
import type { SchedulingService } from "../core/scheduling.js";
import type { DeadlineType } from "../core/deadline.js";
import { buildIcsCalendar, type IcsEvent } from "../core/ics.js";
import type { ReviewGateService } from "./review-service.js";

/**
 * "Add it to my calendar": the deadlines and appointments a person can
 * already see in Docket, as one `.ics` file any calendar app imports.
 *
 * Three decisions carry the design:
 *
 * - **Nothing here is a new read.** Deadlines come through
 *   `ReviewGateService.listUpcomingDeadlines()` (attorney-only, as on the
 *   Deadlines panel) and appointments through `SchedulingService.listAll()`
 *   (matter-scoped by `AccessControl`, as on the Scheduling panel), so a
 *   paralegal's file holds their own matter's appointments and no
 *   deadlines at all — exactly what their panels show.
 * - **An unverified date never looks like a verified one.** A deadline
 *   only one source has seen is titled "UNVERIFIED", and one whose sources
 *   disagree is titled "DISPUTED" and placed on the soonest proposed date
 *   (if one source says Friday and another Tuesday, the firm has until
 *   Friday to find out). Once a date is in someone's phone calendar,
 *   nobody opens Docket to check its status; the title has to say it.
 * - **The file leaves the building, so it says as little as it can.**
 *   Calendar apps sync to their vendor's servers. Events carry matter
 *   numbers, dates, times and the attorney's name — never a matter title
 *   (which usually names the client), a party, or a note.
 *
 * Every export is audited with its counts: it is data leaving Docket for
 * somewhere Docket can't see.
 */

const DEADLINE_LABEL: Record<DeadlineType, string> = {
  speedy_trial: "Speedy-trial deadline",
  arraignment: "Arraignment",
  bail_hearing: "Bail hearing",
  discovery_response: "Discovery response due",
  other: "Deadline",
};

const SOURCE_LABEL: Record<string, string> = {
  agent: "calculated by the drafting agent",
  human: "entered by a person",
  calendar_system: "from the firm calendar",
};

/** Past this many days ago, a deadline isn't worth adding to a calendar. */
const DEADLINE_LOOKBACK_DAYS = 30;
/** How far ahead deadlines are exported. */
const DEADLINE_HORIZON_DAYS = 365;

function stableUid(kind: string, key: string): string {
  // Hashed so the matter id doesn't double as a calendar app's event id,
  // and stable so importing a newer export updates rather than duplicates.
  return `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}@docket`;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface CalendarExport {
  filename: string;
  ics: string;
  deadlineCount: number;
  appointmentCount: number;
  /** True when deadlines were left out because the caller's role can't see them. */
  deadlinesOmitted: boolean;
}

export class CalendarExportService {
  #reviewGate: ReviewGateService | undefined;
  #scheduling: SchedulingService | undefined;
  #auditLog: AuditLog;
  #nameFor: (actorId: string) => string | undefined;
  #calendarName: string;

  #timeZone: string | undefined;

  constructor(params: {
    reviewGate?: ReviewGateService;
    scheduling?: SchedulingService;
    auditLog: AuditLog;
    /** An attorney's display name for an appointment title; absent, the title just omits it. */
    nameFor?: (actorId: string) => string | undefined;
    firmName?: string;
    /** The firm's zone: which day "today" is, for the window and for this morning's appointments. Absent, UTC. */
    timeZone?: string;
  }) {
    this.#timeZone = params.timeZone;
    this.#reviewGate = params.reviewGate;
    this.#scheduling = params.scheduling;
    this.#auditLog = params.auditLog;
    this.#nameFor = params.nameFor ?? (() => undefined);
    this.#calendarName = params.firmName ? `${params.firmName} — Docket` : "Docket";
  }

  export(actor: Actor, options: { now?: Date } = {}): CalendarExport {
    // Staff only. A client sees their matters in My Matters; the machine
    // credential has no calendar; an anonymous caller has nothing.
    if (actor.role !== "attorney" && actor.role !== "paralegal" && actor.role !== "receptionist") {
      throw new AccessDeniedError(`calendar export is for staff (got role '${actor.role}')`);
    }
    const now = options.now ?? new Date();
    const today = todayIn(this.#timeZone, now);
    const events: IcsEvent[] = [];

    let deadlineCount = 0;
    const deadlinesOmitted = actor.role !== "attorney";
    if (!deadlinesOmitted && this.#reviewGate) {
      const earliest = addDays(today, -DEADLINE_LOOKBACK_DAYS);
      const deadlines = this.#reviewGate
        .listUpcomingDeadlines(actor, { today, withinDays: DEADLINE_HORIZON_DAYS })
        .filter((d) => d.date >= earliest)
        .sort((a, b) => a.date.localeCompare(b.date));
      for (const d of deadlines) {
        const label = DEADLINE_LABEL[d.type] ?? "Deadline";
        let summary: string;
        let description: string;
        if (d.confirmationState === "confirmed") {
          summary = `${label} — ${d.matterId}`;
          description = `Confirmed in Docket: two independent sources agree on this date. Matter ${d.matterId}.`;
        } else if (d.confirmationState === "conflict") {
          const proposals = [...new Set(d.calculations.map((c) => `${c.date} (${SOURCE_LABEL[c.source] ?? c.source})`))].join("; ");
          summary = `DISPUTED: ${label} — ${d.matterId}`;
          description =
            `Sources disagree about this date: ${proposals}. Shown on the earliest. ` +
            `Resolve it in Docket's Deadlines panel before relying on any of them. Matter ${d.matterId}.`;
        } else {
          summary = `UNVERIFIED: ${label} — ${d.matterId}`;
          description =
            "Only one source has this date. Don't rely on it until a second, independent source confirms it " +
            `in Docket's Deadlines panel. Matter ${d.matterId}.`;
        }
        events.push({
          uid: stableUid("deadline", `${d.matterId}::${d.type}`),
          summary,
          description,
          start: { date: d.date },
          status: d.confirmationState === "confirmed" ? "CONFIRMED" : "TENTATIVE",
          // A deadline is a date, not a block of time.
          transparent: true,
          alarmBefore: "P1D",
          categories: ["Docket", "Deadline"],
        });
        deadlineCount++;
      }
    }

    let appointmentCount = 0;
    if (this.#scheduling) {
      // From the start of the firm's today, so this morning's consultation
      // is still in it — UTC's midnight is 11am in Sydney, which dropped it.
      const appointments = this.#scheduling
        .listAll(actor)
        .filter((a) => a.status !== "completed" && dayOf(a.startTime, this.#timeZone) >= today)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (const a of appointments) {
        const kind = a.type === "consultation" ? "Consultation" : "Follow-up";
        const attorney = this.#nameFor(a.attorneyId);
        const cancelled = a.status === "cancelled";
        const end = new Date(Date.parse(a.startTime) + a.durationMinutes * 60_000).toISOString();
        events.push({
          uid: stableUid("appointment", a.id),
          summary: `${cancelled ? "CANCELLED: " : ""}${kind} — ${a.matterId}${attorney ? ` with ${attorney}` : ""}`,
          description: cancelled
            ? `Cancelled in Docket. Matter ${a.matterId}.`
            : `Booked in Docket. Matter ${a.matterId}. Open the Scheduling panel for anything else about it.`,
          start: { dateTime: a.startTime },
          end: { dateTime: end },
          // Kept, not dropped: re-importing a cancellation is how a
          // calendar that already has the appointment finds out.
          status: cancelled ? "CANCELLED" : "CONFIRMED",
          alarmBefore: "PT1H",
          categories: ["Docket", "Appointment"],
        });
        appointmentCount++;
      }
    }

    const ics = buildIcsCalendar({ prodId: "-//Docket//Calendar export//EN", name: this.#calendarName, events, now });
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "calendar_exported",
      detail: `deadlines=${deadlineCount} appointments=${appointmentCount}`,
    });
    return { filename: `docket-calendar-${today}.ics`, ics, deadlineCount, appointmentCount, deadlinesOmitted };
  }
}
