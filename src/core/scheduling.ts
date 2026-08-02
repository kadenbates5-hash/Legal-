import { isWithinBusinessHours, type FirmConfig } from "../config/firm-config.js";
import type { AccessControl } from "./access-control.js";
import { AccessDeniedError, type Actor } from "./types.js";

/**
 * §2: "Schedule/reschedule consultations, send reminders." Core,
 * practice-area-agnostic scheduling — no legal-content knowledge, just the
 * mechanics every practice area needs: booking, rescheduling, cancellation,
 * attorney auto-assignment by practice area, double-booking prevention,
 * and computing when reminders are due (sending them is a vendor
 * integration — email/SMS — deliberately out of scope here, same as
 * voice-agent.ts staying vendor-agnostic for STT/TTS).
 */
export class SchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

export type AppointmentType = "consultation" | "follow_up";
export type AppointmentStatus = "scheduled" | "rescheduled" | "cancelled" | "completed";

export interface ReminderRecord {
  readonly id: string;
  readonly offsetMinutesBefore: number;
  readonly dueAt: string;
  sentAt: string | undefined;
}

export interface AppointmentHistoryEntry {
  readonly status: AppointmentStatus;
  readonly at: string;
  readonly note: string | undefined;
}

export interface Appointment {
  readonly id: string;
  readonly matterId: string;
  attorneyId: string;
  type: AppointmentType;
  startTime: string;
  durationMinutes: number;
  status: AppointmentStatus;
  reminders: ReminderRecord[];
  readonly history: AppointmentHistoryEntry[];
  /**
   * The external calendar vendor's event id, once this appointment has
   * been pushed at least once. `undefined` before the first push, or
   * again after the event has been deleted there (see `recordCalendarSync`).
   */
  calendarEventId?: string | undefined;
  /**
   * True whenever this appointment has changed since it was last pushed
   * to the calendar — including on creation, so a brand-new appointment
   * is always due for its first sync. Only `recordCalendarSync` (the
   * sync engine's own write-back) clears it; nothing else in this class
   * can mark a change as already synced, since core has no idea whether
   * any vendor is even configured.
   */
  calendarSyncPending: boolean;
}

/** Default reminders: one day before, and one hour before. */
const DEFAULT_REMINDER_OFFSETS_MINUTES = [24 * 60, 60];
const DEFAULT_DURATION_MINUTES = 30;

let appointmentSequence = 0;
function nextAppointmentId(): string {
  appointmentSequence += 1;
  return `appt_${appointmentSequence}`;
}

export interface ScheduleConsultationParams {
  matterId: string;
  startTime: Date;
  durationMinutes?: number;
  type?: AppointmentType;
  /** Explicit attorney, or omit and supply practiceAreaId for auto-assignment from FirmConfig. */
  attorneyId?: string;
  practiceAreaId?: string;
  /** Escalation-driven bookings (e.g. an urgent follow-up) may need to bypass the business-hours check. */
  allowOutsideBusinessHours?: boolean;
}

export interface RescheduleParams {
  newStartTime: Date;
  allowOutsideBusinessHours?: boolean;
}

export class SchedulingService {
  #appointments = new Map<string, Appointment>();
  #firmConfig: FirmConfig | undefined;
  #accessControl: AccessControl | undefined;
  #reminderOffsetsMinutes: number[];

  constructor(params?: { firmConfig?: FirmConfig; accessControl?: AccessControl; reminderOffsetsMinutes?: number[] }) {
    this.#firmConfig = params?.firmConfig;
    this.#accessControl = params?.accessControl;
    this.#reminderOffsetsMinutes = params?.reminderOffsetsMinutes ?? DEFAULT_REMINDER_OFFSETS_MINUTES;
  }

  scheduleConsultation(actor: Actor, params: ScheduleConsultationParams): Appointment {
    this.#authorize(actor, params.matterId);

    const attorneyId = params.attorneyId ?? this.#autoAssignAttorney(params.practiceAreaId);
    if (!attorneyId) {
      throw new SchedulingError("no attorney available to assign — check FirmConfig.attorneys");
    }

    this.#assertBusinessHours(params.startTime, params.allowOutsideBusinessHours);

    const durationMinutes = params.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    this.#assertNoOverlap(attorneyId, params.startTime, durationMinutes);

    const appointment: Appointment = {
      id: nextAppointmentId(),
      matterId: params.matterId,
      attorneyId,
      type: params.type ?? "consultation",
      startTime: params.startTime.toISOString(),
      durationMinutes,
      status: "scheduled",
      reminders: this.#buildReminders(params.startTime),
      history: [{ status: "scheduled", at: new Date().toISOString(), note: undefined }],
      calendarSyncPending: true,
    };
    this.#appointments.set(appointment.id, appointment);
    return appointment;
  }

  reschedule(actor: Actor, id: string, params: RescheduleParams): Appointment {
    const appointment = this.#require(id);
    this.#authorize(actor, appointment.matterId);

    if (appointment.status === "cancelled" || appointment.status === "completed") {
      throw new SchedulingError(`cannot reschedule a '${appointment.status}' appointment`);
    }

    this.#assertBusinessHours(params.newStartTime, params.allowOutsideBusinessHours);
    this.#assertNoOverlap(appointment.attorneyId, params.newStartTime, appointment.durationMinutes, id);

    appointment.startTime = params.newStartTime.toISOString();
    appointment.status = "rescheduled";
    appointment.reminders = this.#buildReminders(params.newStartTime);
    appointment.history.push({ status: "rescheduled", at: new Date().toISOString(), note: undefined });
    appointment.calendarSyncPending = true;
    return appointment;
  }

  cancel(actor: Actor, id: string, reason?: string): Appointment {
    const appointment = this.#require(id);
    this.#authorize(actor, appointment.matterId);

    if (appointment.status === "completed") {
      throw new SchedulingError("cannot cancel a completed appointment");
    }
    appointment.status = "cancelled";
    appointment.history.push({ status: "cancelled", at: new Date().toISOString(), note: reason });
    // A cancelled appointment still needs a sync pass — that's what
    // removes the now-stale event from the calendar.
    appointment.calendarSyncPending = true;
    return appointment;
  }

  complete(actor: Actor, id: string): Appointment {
    const appointment = this.#require(id);
    this.#authorize(actor, appointment.matterId);

    if (appointment.status === "cancelled") {
      throw new SchedulingError("cannot complete a cancelled appointment");
    }
    appointment.status = "completed";
    appointment.history.push({ status: "completed", at: new Date().toISOString(), note: undefined });
    return appointment;
  }

  /**
   * Every appointment whose calendar event is out of date with its
   * current state — new, rescheduled, cancelled, or never pushed at
   * all. The sync engine's whole read side; nothing here knows or cares
   * whether any calendar vendor is even configured.
   *
   * Restricted to the `"system"` role, same as `recordCalendarSync` —
   * this is inherently a firm-wide, cross-matter read (the sync engine
   * has to see every pending appointment in one pass), which no other
   * role's matter-scoping is meant to allow. Per-matter filtering would
   * silently return nothing to the one caller that's supposed to see
   * everything.
   */
  listPendingCalendarSync(actor: Actor): Appointment[] {
    if (actor.role !== "system") {
      throw new AccessDeniedError(`listing pending calendar syncs requires the system credential (got role '${actor.role}')`);
    }
    return [...this.#appointments.values()].filter((a) => a.calendarSyncPending);
  }

  /**
   * The sync engine's write-back after a successful push: records the
   * vendor's event id (or `undefined`, once a cancelled appointment's
   * event has been deleted there) and clears the pending flag. Restricted
   * to the `"system"` role — the same credential `confirmDeadline`
   * requires for a `calendar_system` source — since this is a machine
   * writing sync metadata about itself, not a human changing what the
   * appointment actually is.
   */
  recordCalendarSync(actor: Actor, id: string, calendarEventId: string | undefined): Appointment {
    if (actor.role !== "system") {
      throw new AccessDeniedError(`recording a calendar sync requires the system credential (got role '${actor.role}')`);
    }
    const appointment = this.#require(id);
    appointment.calendarEventId = calendarEventId;
    appointment.calendarSyncPending = false;
    return appointment;
  }

  /** Throws if this actor can't reach the appointment's matter — a caller named one specific id, so a filtered-away result would just be confusing, not protective. */
  get(actor: Actor, id: string): Appointment | undefined {
    const appointment = this.#appointments.get(id);
    if (!appointment) return undefined;
    this.#authorize(actor, appointment.matterId);
    return appointment;
  }

  /** Throws if this actor can't reach the named matter at all — same reasoning as `get`. */
  listByMatter(actor: Actor, matterId: string): Appointment[] {
    this.#authorize(actor, matterId);
    return [...this.#appointments.values()].filter((a) => a.matterId === matterId);
  }

  /**
   * Spans matters by design (an attorney's whole calendar), so a matter
   * this actor can't reach is silently omitted rather than raising —
   * the same "don't leak which matters exist" reasoning `CasesService`/
   * `SearchService` use, since erroring on the first inaccessible one
   * would defeat the point of an attorney-wide view.
   */
  listByAttorney(actor: Actor, attorneyId: string): Appointment[] {
    return [...this.#appointments.values()].filter((a) => a.attorneyId === attorneyId && this.#canSee(actor, a.matterId));
  }

  /** Every matter this actor can reach — silently omitting ones it can't, same as `listByAttorney`. */
  listAll(actor: Actor): Appointment[] {
    return [...this.#appointments.values()].filter((a) => this.#canSee(actor, a.matterId));
  }

  /**
   * Reminders whose due time has passed, haven't been sent, and belong
   * to a still-active appointment. Firm-wide by nature — a reminder-
   * sending job needs to see every one in a single pass — so the
   * `"system"` role sees everything unscoped, same as
   * `listPendingCalendarSync`. Every other role gets the same
   * matter-scoped, silently-omitting filter as `listAll`: this same
   * method backs the in-app Scheduling panel's "Coming due" reminders
   * card, which a receptionist or paralegal reads day to day.
   */
  getDueReminders(actor: Actor, now: Date = new Date()): Array<{ appointment: Appointment; reminder: ReminderRecord }> {
    const due: Array<{ appointment: Appointment; reminder: ReminderRecord }> = [];
    const unscoped = actor.role === "system";
    for (const appointment of this.#appointments.values()) {
      if (appointment.status === "cancelled" || appointment.status === "completed") continue;
      if (!unscoped && !this.#canSee(actor, appointment.matterId)) continue;
      for (const reminder of appointment.reminders) {
        if (!reminder.sentAt && Date.parse(reminder.dueAt) <= now.getTime()) {
          due.push({ appointment, reminder });
        }
      }
    }
    return due;
  }

  /**
   * Restricted to the `"system"` role, same as `recordCalendarSync` —
   * this is the reminder-sending job's own write-back confirming a
   * reminder actually went out. No human role has a "mark sent" button
   * anywhere in the UI; the only legitimate caller is the process that
   * just sent the email.
   */
  markReminderSent(actor: Actor, appointmentId: string, reminderId: string, at: Date = new Date()): Appointment {
    if (actor.role !== "system") {
      throw new AccessDeniedError(`marking a reminder sent requires the system credential (got role '${actor.role}')`);
    }
    const appointment = this.#require(appointmentId);
    const reminder = appointment.reminders.find((r) => r.id === reminderId);
    if (!reminder) {
      throw new SchedulingError(`no reminder '${reminderId}' on appointment '${appointmentId}'`);
    }
    reminder.sentAt = at.toISOString();
    // Returned directly rather than making the caller re-fetch via
    // `get(actor, id)` — the system credential that's the only legitimate
    // caller here has no `"scheduling"` grant in AccessControl, so that
    // second lookup would deny exactly the actor that just succeeded.
    return appointment;
  }

  /** Persistence's own read, unscoped by design — it has to see every appointment regardless of any actor, the same reasoning `#assertNoOverlap` already iterates the raw map directly. */
  toSnapshot(): Appointment[] {
    return [...this.#appointments.values()].map((a) => ({
      ...a,
      reminders: a.reminders.map((r) => ({ ...r })),
      history: a.history.map((h) => ({ ...h })),
    }));
  }

  static fromSnapshot(
    snapshots: readonly Appointment[],
    params?: { firmConfig?: FirmConfig; accessControl?: AccessControl },
  ): SchedulingService {
    const service = new SchedulingService(params);
    for (const snapshot of snapshots) {
      service.#appointments.set(snapshot.id, {
        ...snapshot,
        reminders: snapshot.reminders.map((r) => ({ ...r })),
        history: snapshot.history.map((h) => ({ ...h })),
        // A snapshot predating this field has never been pushed anywhere —
        // treat it as pending so turning the sync on catches up on it,
        // rather than silently treating "never recorded" as "already synced".
        calendarSyncPending: snapshot.calendarSyncPending ?? true,
      });
    }
    return service;
  }

  #authorize(actor: Actor, matterId: string): void {
    this.#accessControl?.authorize({ actor, matterId, category: "scheduling" });
  }

  /** Same check as `#authorize`, as a boolean for filtering a list rather than rejecting a single request. */
  #canSee(actor: Actor, matterId: string): boolean {
    if (!this.#accessControl) return true;
    try {
      this.#accessControl.authorize({ actor, matterId, category: "scheduling" });
      return true;
    } catch {
      return false;
    }
  }

  #assertBusinessHours(at: Date, allowOutsideBusinessHours?: boolean): void {
    if (allowOutsideBusinessHours) return;
    if (this.#firmConfig && !isWithinBusinessHours(this.#firmConfig, at)) {
      throw new SchedulingError("requested time is outside business hours");
    }
  }

  #assertNoOverlap(attorneyId: string, startTime: Date, durationMinutes: number, excludeId?: string): void {
    const start = startTime.getTime();
    const end = start + durationMinutes * 60_000;
    for (const appointment of this.#appointments.values()) {
      if (appointment.id === excludeId) continue;
      if (appointment.attorneyId !== attorneyId) continue;
      if (appointment.status === "cancelled") continue;
      const otherStart = Date.parse(appointment.startTime);
      const otherEnd = otherStart + appointment.durationMinutes * 60_000;
      if (start < otherEnd && otherStart < end) {
        throw new SchedulingError(`attorney '${attorneyId}' already has an appointment overlapping this time`);
      }
    }
  }

  #autoAssignAttorney(practiceAreaId?: string): string | undefined {
    const attorneys = this.#firmConfig?.attorneys ?? [];
    if (attorneys.length === 0) return undefined;
    if (!practiceAreaId) return attorneys[0]?.id;
    return (attorneys.find((a) => a.practiceAreaIds.includes(practiceAreaId)) ?? attorneys[0])?.id;
  }

  #buildReminders(startTime: Date): ReminderRecord[] {
    return this.#reminderOffsetsMinutes.map((offset, i) => ({
      id: `rem_${i}`,
      offsetMinutesBefore: offset,
      dueAt: new Date(startTime.getTime() - offset * 60_000).toISOString(),
      sentAt: undefined,
    }));
  }

  #require(id: string): Appointment {
    const appointment = this.#appointments.get(id);
    if (!appointment) {
      throw new SchedulingError(`no appointment '${id}'`);
    }
    return appointment;
  }
}
