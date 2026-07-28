import { describe, expect, it } from "vitest";
import { SchedulingService, SchedulingError } from "../src/core/scheduling.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import type { FirmConfig } from "../src/config/firm-config.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const receptionist: Actor = { id: "r1", role: "receptionist" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeFirmConfig(overrides?: Partial<FirmConfig>): FirmConfig {
  return {
    firmName: "Test Firm",
    attorneys: [
      { id: "a1", name: "Alice Attorney", practiceAreaIds: ["criminal-law"] },
      { id: "a2", name: "Bob Attorney", practiceAreaIds: ["family-law"] },
    ],
    businessHours: { timezone: "America/New_York", open: "09:00", close: "17:00", days: [1, 2, 3, 4, 5] },
    branding: { tone: "warm", greeting: "Welcome." },
    jurisdictionRecordingConsent: "two-party-consent",
    ...overrides,
  };
}

// 2026-07-22 is a Wednesday; 15:00 UTC = 11:00 America/New_York (within 09:00-17:00).
const DURING_BUSINESS_HOURS = new Date("2026-07-22T15:00:00Z");
// 22:00 UTC = 18:00 America/New_York — after close.
const AFTER_HOURS = new Date("2026-07-22T22:00:00Z");

describe("SchedulingService — booking", () => {
  it("books a consultation, auto-assigning an attorney by practice area", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      practiceAreaId: "criminal-law",
    });
    expect(appt.attorneyId).toBe("a1");
    expect(appt.status).toBe("scheduled");
    expect(appt.durationMinutes).toBe(30);
  });

  it("falls back to the first attorney when no practice-area match exists", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      practiceAreaId: "immigration-law",
    });
    expect(appt.attorneyId).toBe("a1");
  });

  it("respects an explicit attorneyId over auto-assignment", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a2",
      practiceAreaId: "criminal-law",
    });
    expect(appt.attorneyId).toBe("a2");
  });

  it("throws when no attorney can be assigned at all", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig({ attorneys: [] }) });
    expect(() => service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS })).toThrow(
      SchedulingError,
    );
  });

  it("rejects a booking outside business hours by default", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    expect(() =>
      service.scheduleConsultation(receptionist, { matterId: "m1", startTime: AFTER_HOURS, practiceAreaId: "criminal-law" }),
    ).toThrow(SchedulingError);
  });

  it("allows bypassing the business-hours check explicitly", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: AFTER_HOURS,
      practiceAreaId: "criminal-law",
      allowOutsideBusinessHours: true,
    });
    expect(appt.status).toBe("scheduled");
  });

  it("works with no firm config at all — no business-hours or auto-assignment constraint applied", () => {
    const service = new SchedulingService();
    expect(() => service.scheduleConsultation(receptionist, { matterId: "m1", startTime: AFTER_HOURS })).toThrow(
      /no attorney available/,
    );
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: AFTER_HOURS, attorneyId: "a9" });
    expect(appt.attorneyId).toBe("a9");
  });

  it("prevents double-booking the same attorney for overlapping times", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      durationMinutes: 60,
      attorneyId: "a1",
    });
    const overlapping = new Date(DURING_BUSINESS_HOURS.getTime() + 30 * 60_000);
    expect(() =>
      service.scheduleConsultation(receptionist, { matterId: "m2", startTime: overlapping, attorneyId: "a1" }),
    ).toThrow(/overlapping/);
  });

  it("allows back-to-back (non-overlapping) appointments for the same attorney", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      durationMinutes: 30,
      attorneyId: "a1",
    });
    const backToBack = new Date(DURING_BUSINESS_HOURS.getTime() + 30 * 60_000);
    expect(() =>
      service.scheduleConsultation(receptionist, { matterId: "m2", startTime: backToBack, attorneyId: "a1" }),
    ).not.toThrow();
  });

  it("does not count a cancelled appointment's slot as occupied", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const first = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.cancel(receptionist, first.id);
    expect(() =>
      service.scheduleConsultation(receptionist, { matterId: "m2", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" }),
    ).not.toThrow();
  });
});

describe("SchedulingService — rescheduling and cancellation", () => {
  it("reschedules to a new time, checking overlap and business hours again", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    const newTime = new Date(DURING_BUSINESS_HOURS.getTime() + 3 * 60 * 60_000);
    const updated = service.reschedule(receptionist, appt.id, { newStartTime: newTime });
    expect(updated.status).toBe("rescheduled");
    expect(updated.startTime).toBe(newTime.toISOString());
  });

  it("recomputes reminders relative to the new time on reschedule", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    const originalReminderDue = appt.reminders[0]!.dueAt;
    const newTime = new Date(DURING_BUSINESS_HOURS.getTime() + 3 * 60 * 60_000);
    const updated = service.reschedule(receptionist, appt.id, { newStartTime: newTime });
    expect(updated.reminders[0]!.dueAt).not.toBe(originalReminderDue);
  });

  it("refuses to reschedule a cancelled appointment", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.cancel(receptionist, appt.id);
    expect(() => service.reschedule(receptionist, appt.id, { newStartTime: DURING_BUSINESS_HOURS })).toThrow(
      SchedulingError,
    );
  });

  it("cancels an appointment with an optional reason, recorded in history", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    const cancelled = service.cancel(receptionist, appt.id, "client no longer needs consultation");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.history.at(-1)?.note).toBe("client no longer needs consultation");
  });

  it("completes an appointment", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    const completed = service.complete(receptionist, appt.id);
    expect(completed.status).toBe("completed");
  });

  it("refuses to cancel a completed appointment", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.complete(receptionist, appt.id);
    expect(() => service.cancel(receptionist, appt.id)).toThrow(SchedulingError);
  });

  it("throws a clear error for an unknown appointment id", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    expect(() => service.cancel(receptionist, "nope")).toThrow(/no appointment/);
  });
});

describe("SchedulingService — access control", () => {
  it("enforces the 'scheduling' access category when an AccessControl is supplied", () => {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const service = new SchedulingService({ firmConfig: makeFirmConfig(), accessControl });

    // receptionist is allowed scheduling access by default (see access-control.ts).
    expect(() =>
      service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" }),
    ).not.toThrow();
  });

  it("denies an actor without scheduling access (e.g. an unassigned paralegal)", () => {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const service = new SchedulingService({ firmConfig: makeFirmConfig(), accessControl });

    expect(() =>
      service.scheduleConsultation(paralegal, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" }),
    ).toThrow(AccessDeniedError);
  });
});

describe("SchedulingService — reminders", () => {
  it("computes default 24h-before and 1h-before reminders", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    expect(appt.reminders).toHaveLength(2);
    expect(appt.reminders[0]!.offsetMinutesBefore).toBe(24 * 60);
    expect(appt.reminders[1]!.offsetMinutesBefore).toBe(60);
    expect(Date.parse(appt.reminders[0]!.dueAt)).toBe(DURING_BUSINESS_HOURS.getTime() - 24 * 60 * 60_000);
  });

  it("supports custom reminder offsets", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig(), reminderOffsetsMinutes: [10] });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    expect(appt.reminders).toHaveLength(1);
    expect(appt.reminders[0]!.offsetMinutesBefore).toBe(10);
  });

  it("surfaces only reminders whose due time has passed and aren't sent yet", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig(), reminderOffsetsMinutes: [60, 5] });
    service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });

    const beforeAnyDue = service.getDueReminders(new Date(DURING_BUSINESS_HOURS.getTime() - 120 * 60_000));
    expect(beforeAnyDue).toHaveLength(0);

    const afterFirstDue = service.getDueReminders(new Date(DURING_BUSINESS_HOURS.getTime() - 30 * 60_000));
    expect(afterFirstDue).toHaveLength(1);
    expect(afterFirstDue[0]!.reminder.offsetMinutesBefore).toBe(60);

    const afterBothDue = service.getDueReminders(DURING_BUSINESS_HOURS);
    expect(afterBothDue).toHaveLength(2);
  });

  it("excludes reminders already marked sent", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.markReminderSent(appt.id, appt.reminders[0]!.id);
    const due = service.getDueReminders(DURING_BUSINESS_HOURS);
    expect(due.some((d) => d.reminder.id === appt.reminders[0]!.id)).toBe(false);
  });

  it("excludes reminders for cancelled appointments", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.cancel(receptionist, appt.id);
    expect(service.getDueReminders(DURING_BUSINESS_HOURS)).toHaveLength(0);
  });
});

describe("SchedulingService — listing and snapshots", () => {
  it("lists appointments by matter and by attorney", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    service.scheduleConsultation(receptionist, {
      matterId: "m2",
      startTime: new Date(DURING_BUSINESS_HOURS.getTime() + 60 * 60_000),
      attorneyId: "a1",
    });
    service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: new Date(DURING_BUSINESS_HOURS.getTime() + 120 * 60_000),
      attorneyId: "a2",
    });

    expect(service.listByMatter("m1")).toHaveLength(2);
    expect(service.listByAttorney("a1")).toHaveLength(2);
    expect(service.listAll()).toHaveLength(3);
  });

  it("round-trips through a snapshot, preserving status/reminders/history exactly", () => {
    const config = makeFirmConfig();
    const service = new SchedulingService({ firmConfig: config });
    const appt = service.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: DURING_BUSINESS_HOURS,
      attorneyId: "a1",
    });
    service.markReminderSent(appt.id, appt.reminders[0]!.id);

    const restored = SchedulingService.fromSnapshot(service.toSnapshot(), { firmConfig: config });
    const restoredAppt = restored.get(appt.id);
    expect(restoredAppt?.status).toBe("scheduled");
    expect(restoredAppt?.reminders[0]?.sentAt).toBeDefined();
    expect(restoredAppt?.history).toEqual(appt.history);

    // Restored service is still fully functional — new bookings still respect the existing one's slot.
    expect(() =>
      restored.scheduleConsultation(receptionist, { matterId: "m2", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" }),
    ).toThrow(/overlapping/);
  });
});

describe("SchedulingService — calendar sync", () => {
  const system: Actor = { id: "sys", role: "system" };

  it("marks a new appointment pending, and it appears in the pending list", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    expect(appt.calendarSyncPending).toBe(true);
    expect(service.listPendingCalendarSync().map((a) => a.id)).toEqual([appt.id]);
  });

  it("recordCalendarSync clears the pending flag and stores the vendor event id", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    const updated = service.recordCalendarSync(system, appt.id, "gcal-event-1");
    expect(updated.calendarSyncPending).toBe(false);
    expect(updated.calendarEventId).toBe("gcal-event-1");
    expect(service.listPendingCalendarSync()).toEqual([]);
  });

  it("rescheduling or cancelling marks it pending again, even after a previous sync", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    service.recordCalendarSync(system, appt.id, "gcal-event-1");

    service.reschedule(receptionist, appt.id, { newStartTime: new Date(DURING_BUSINESS_HOURS.getTime() + 3_600_000) });
    expect(service.get(appt.id)?.calendarSyncPending).toBe(true);
    // The old event id is preserved until the sync engine overwrites it — a reschedule updates the same event, it doesn't lose track of it.
    expect(service.get(appt.id)?.calendarEventId).toBe("gcal-event-1");

    service.recordCalendarSync(system, appt.id, "gcal-event-1");
    service.cancel(receptionist, appt.id);
    expect(service.get(appt.id)?.calendarSyncPending).toBe(true);
  });

  it("restricts recordCalendarSync to the system role", () => {
    const service = new SchedulingService({ firmConfig: makeFirmConfig() });
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    expect(() => service.recordCalendarSync(receptionist, appt.id, "gcal-event-1")).toThrow(AccessDeniedError);
    expect(() => service.recordCalendarSync({ id: "a1", role: "attorney" }, appt.id, "gcal-event-1")).toThrow(AccessDeniedError);
  });

  it("an old snapshot with no calendarSyncPending field defaults to pending, so turning sync on catches up", () => {
    const config = makeFirmConfig();
    const service = new SchedulingService({ firmConfig: config });
    const appt = service.scheduleConsultation(receptionist, { matterId: "m1", startTime: DURING_BUSINESS_HOURS, attorneyId: "a1" });
    service.recordCalendarSync(system, appt.id, "gcal-event-1");

    const legacySnapshot = service.toSnapshot().map(({ calendarSyncPending: _drop, ...rest }) => rest);
    const restored = SchedulingService.fromSnapshot(legacySnapshot as never, { firmConfig: config });
    expect(restored.listPendingCalendarSync().map((a) => a.id)).toEqual([appt.id]);
  });
});
