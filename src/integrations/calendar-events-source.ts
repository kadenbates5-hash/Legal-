import type { DeadlineType } from "../core/deadline.js";

/**
 * Vendor-agnostic seam for §7 item #1's remaining open piece: a real
 * calendar vendor presenting the "calendar_system" credential (see
 * `core/auth.ts`'s `verifySystemApiKey` and `review-service.ts`'s
 * `confirmDeadline` source/role gating). A calendar event is the
 * independent, human-placed confirmation of a deadline date — this
 * interface is deliberately narrow (list only, no writes) so the
 * integration can only ever supply confirmations, never silently
 * change/delete deadline history itself.
 *
 * `google-calendar.ts` is the only implementation today; the interface
 * exists so a firm on Outlook/Exchange could swap in an equivalent
 * without touching `calendar-deadline-sync.ts`.
 */
export interface CalendarDeadlineEvent {
  /** The calendar vendor's own event id — surfaced only for logging/diagnostics. */
  eventId: string;
  matterId: string;
  deadlineType: DeadlineType;
  /** YYYY-MM-DD, matching the format `DeadlineTracker`/the Deadlines panel already use. */
  date: string;
}

export interface CalendarEventsSource {
  /** Every calendar event tagged with a matterId/deadlineType this integration should confirm. */
  listDeadlineEvents(): Promise<CalendarDeadlineEvent[]>;
}
