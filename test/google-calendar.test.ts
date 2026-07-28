import { describe, expect, it } from "vitest";
import { parseDeadlineEvent, buildAppointmentEventBody } from "../src/integrations/google-calendar.js";

describe("parseDeadlineEvent", () => {
  it("parses a valid all-day event", () => {
    const event = parseDeadlineEvent({
      id: "evt_1",
      start: { date: "2026-09-01" },
      extendedProperties: { private: { matterId: "m1", deadlineType: "speedy_trial", docketDeadline: "true" } },
    });
    expect(event).toEqual({ eventId: "evt_1", matterId: "m1", deadlineType: "speedy_trial", date: "2026-09-01" });
  });

  it("parses a timed event, taking only the date portion", () => {
    const event = parseDeadlineEvent({
      id: "evt_2",
      start: { dateTime: "2026-09-01T14:00:00-04:00" },
      extendedProperties: { private: { matterId: "m1", deadlineType: "arraignment" } },
    });
    expect(event?.date).toBe("2026-09-01");
  });

  it("rejects an event missing matterId", () => {
    const event = parseDeadlineEvent({
      id: "evt_3",
      start: { date: "2026-09-01" },
      extendedProperties: { private: { deadlineType: "arraignment" } },
    });
    expect(event).toBeUndefined();
  });

  it("rejects an event with an invalid deadlineType", () => {
    const event = parseDeadlineEvent({
      id: "evt_4",
      start: { date: "2026-09-01" },
      extendedProperties: { private: { matterId: "m1", deadlineType: "not_a_real_type" } },
    });
    expect(event).toBeUndefined();
  });

  it("rejects an event with no start date at all", () => {
    const event = parseDeadlineEvent({
      id: "evt_5",
      extendedProperties: { private: { matterId: "m1", deadlineType: "arraignment" } },
    });
    expect(event).toBeUndefined();
  });

  it("rejects an event with no extendedProperties", () => {
    const event = parseDeadlineEvent({ id: "evt_6", start: { date: "2026-09-01" } });
    expect(event).toBeUndefined();
  });
});

describe("buildAppointmentEventBody", () => {
  it("computes the end time from start + duration, and labels a consultation", () => {
    const body = buildAppointmentEventBody("appt_1", {
      matterId: "m1",
      attorneyId: "a1",
      type: "consultation",
      startTime: "2026-09-01T14:00:00.000Z",
      durationMinutes: 30,
    });
    expect(body.summary).toBe("Consultation — matter m1");
    expect(body.start).toEqual({ dateTime: "2026-09-01T14:00:00.000Z" });
    expect(body.end).toEqual({ dateTime: "2026-09-01T14:30:00.000Z" });
  });

  it("labels a follow-up distinctly", () => {
    const body = buildAppointmentEventBody("appt_2", {
      matterId: "m2",
      attorneyId: "a1",
      type: "follow_up",
      startTime: "2026-09-01T14:00:00.000Z",
      durationMinutes: 15,
    });
    expect(body.summary).toBe("Follow-up — matter m2");
  });

  it("carries structured data a future read could key on, not just the free-text summary", () => {
    const body = buildAppointmentEventBody("appt_3", {
      matterId: "m1",
      attorneyId: "a7",
      type: "consultation",
      startTime: "2026-09-01T14:00:00.000Z",
      durationMinutes: 30,
    });
    expect(body.extendedProperties.private).toEqual({
      docketAppointment: "true",
      appointmentId: "appt_3",
      matterId: "m1",
      attorneyId: "a7",
      type: "consultation",
    });
  });
});
