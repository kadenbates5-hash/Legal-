import type { CalendarEventPublisher } from "./calendar-event-publisher.js";

/**
 * Practice-area/vendor-agnostic sync engine for the direction
 * `calendar-deadline-sync.ts` doesn't cover: pushing `Appointment`s
 * *out* to a shared calendar rather than reading deadline confirmations
 * in. Same shape and same reasoning — it reads pending appointments and
 * writes the result back through Docket's own HTTP API using the
 * `x-system-api-key` credential, never a shortcut straight into
 * `SchedulingService`. That keeps this integration honest about being
 * "just another client": it can't record a sync the API itself wouldn't
 * accept from any `"system"`-role caller.
 */
export interface AppointmentCalendarSyncResult {
  pushed: number;
  deleted: number;
  failures: { appointmentId: string; error: string }[];
}

interface SyncedAppointment {
  id: string;
  matterId: string;
  attorneyId: string;
  type: "consultation" | "follow_up";
  startTime: string;
  durationMinutes: number;
  status: "scheduled" | "rescheduled" | "cancelled" | "completed";
  calendarEventId?: string;
}

export class AppointmentCalendarSync {
  #publisher: CalendarEventPublisher;
  #docketBaseUrl: string;
  #systemApiKey: string;

  constructor(params: { publisher: CalendarEventPublisher; docketBaseUrl: string; systemApiKey: string }) {
    this.#publisher = params.publisher;
    this.#docketBaseUrl = params.docketBaseUrl.replace(/\/+$/, "");
    this.#systemApiKey = params.systemApiKey;
  }

  async run(): Promise<AppointmentCalendarSyncResult> {
    const appointments = await this.#fetchPending();
    const result: AppointmentCalendarSyncResult = { pushed: 0, deleted: 0, failures: [] };

    for (const appointment of appointments) {
      try {
        if (appointment.status === "cancelled") {
          if (appointment.calendarEventId) {
            await this.#publisher.deleteEvent(appointment.calendarEventId);
            result.deleted++;
          }
          await this.#recordSync(appointment.id, undefined);
        } else {
          const eventId = await this.#publisher.upsertEvent(appointment.id, appointment.calendarEventId, {
            matterId: appointment.matterId,
            attorneyId: appointment.attorneyId,
            type: appointment.type,
            startTime: appointment.startTime,
            durationMinutes: appointment.durationMinutes,
          });
          result.pushed++;
          await this.#recordSync(appointment.id, eventId);
        }
      } catch (err) {
        result.failures.push({ appointmentId: appointment.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return result;
  }

  async #fetchPending(): Promise<SyncedAppointment[]> {
    const res = await fetch(`${this.#docketBaseUrl}/api/appointments?pendingCalendarSync=true`, {
      headers: { "x-system-api-key": this.#systemApiKey },
    });
    if (!res.ok) {
      throw new Error(`fetching pending appointments failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as SyncedAppointment[];
  }

  async #recordSync(appointmentId: string, calendarEventId: string | undefined): Promise<void> {
    const res = await fetch(`${this.#docketBaseUrl}/api/appointments/${encodeURIComponent(appointmentId)}/calendar-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": this.#systemApiKey },
      body: JSON.stringify(calendarEventId ? { calendarEventId } : {}),
    });
    if (!res.ok) {
      throw new Error(`recording calendar sync failed (${res.status}): ${await res.text()}`);
    }
  }
}
