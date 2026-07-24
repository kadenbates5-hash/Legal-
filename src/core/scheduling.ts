import { isWithinBusinessHours, type FirmConfig } from "../config/firm-config.js";
import type { AccessControl } from "./access-control.js";
import type { Actor } from "./types.js";

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

  get(id: string): Appointment | undefined {
    return this.#appointments.get(id);
  }

  listByMatter(matterId: string): Appointment[] {
    return [...this.#appointments.values()].filter((a) => a.matterId === matterId);
  }

  listByAttorney(attorneyId: string): Appointment[] {
    return [...this.#appointments.values()].filter((a) => a.attorneyId === attorneyId);
  }

  listAll(): Appointment[] {
    return [...this.#appointments.values()];
  }

  /** Reminders whose due time has passed, haven't been sent, and belong to a still-active appointment. */
  getDueReminders(now: Date = new Date()): Array<{ appointment: Appointment; reminder: ReminderRecord }> {
    const due: Array<{ appointment: Appointment; reminder: ReminderRecord }> = [];
    for (const appointment of this.#appointments.values()) {
      if (appointment.status === "cancelled" || appointment.status === "completed") continue;
      for (const reminder of appointment.reminders) {
        if (!reminder.sentAt && Date.parse(reminder.dueAt) <= now.getTime()) {
          due.push({ appointment, reminder });
        }
      }
    }
    return due;
  }

  markReminderSent(appointmentId: string, reminderId: string, at: Date = new Date()): void {
    const appointment = this.#require(appointmentId);
    const reminder = appointment.reminders.find((r) => r.id === reminderId);
    if (!reminder) {
      throw new SchedulingError(`no reminder '${reminderId}' on appointment '${appointmentId}'`);
    }
    reminder.sentAt = at.toISOString();
  }

  toSnapshot(): Appointment[] {
    return this.listAll().map((a) => ({
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
      });
    }
    return service;
  }

  #authorize(actor: Actor, matterId: string): void {
    this.#accessControl?.authorize({ actor, matterId, category: "scheduling" });
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
