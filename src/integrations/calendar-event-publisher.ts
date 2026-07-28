import type { AppointmentType } from "../core/scheduling.js";

/**
 * Vendor-agnostic seam for pushing `Appointment`s out to a shared
 * calendar — the direction `google-calendar.ts`'s `CalendarEventsSource`
 * doesn't cover, which only reads deadline confirmations back in.
 * Deliberately its own interface rather than extending
 * `CalendarEventsSource`: reading a deadline confirmation and writing an
 * appointment event are different capabilities with different
 * failure/authorization shapes, and a vendor could reasonably support
 * one without the other.
 *
 * `google-calendar.ts`'s `GoogleCalendarEventPublisher` is the only
 * implementation today; a firm on Outlook/Exchange would implement this
 * interface instead, and `appointment-calendar-sync.ts` (the engine that
 * actually calls it) would need no changes.
 */
export interface CalendarEventDraft {
  matterId: string;
  attorneyId: string;
  type: AppointmentType;
  /** ISO 8601. */
  startTime: string;
  durationMinutes: number;
}

export interface CalendarEventPublisher {
  /**
   * Creates the event if `existingEventId` is absent, otherwise updates
   * it in place. Returns the vendor's event id either way, so the caller
   * can record it even on a fresh create.
   */
  upsertEvent(appointmentId: string, existingEventId: string | undefined, draft: CalendarEventDraft): Promise<string>;

  /** Removes an event outright — used when its appointment is cancelled. */
  deleteEvent(eventId: string): Promise<void>;
}
