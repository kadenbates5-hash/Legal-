import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarDayIn, checkedTimeZone, dayOf, isTimeZone, todayIn } from "../src/core/calendar-date.js";
import { parseHoursUntil } from "../src/receptionist/signal-extraction.js";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { renderInvoice } from "../src/core/invoice-render.js";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import { validateBookingSubmission, type BookingSubmission } from "../src/core/booking-requests.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { CalendarExportService } from "../src/review-ui/calendar-export-service.js";
import type { FirmConfig } from "../src/config/firm-config.js";
import type { Actor } from "../src/core/types.js";

/**
 * "Today" is a question about a place. These all used to ask it of the
 * server — UTC on most hosts — which is already on tomorrow from 7pm in
 * New York and still on yesterday until 11am in Sydney.
 */

/** Friday 27 November, 8pm in New York — already Saturday the 28th in UTC. */
const NY_EVENING = new Date("2026-11-28T01:00:00Z");
/** Saturday 28 November, 1am in Sydney — still Friday the 27th in UTC. */
const SYDNEY_SMALL_HOURS = new Date("2026-11-27T14:00:00Z");

const attorney: Actor = { id: "a1", role: "attorney" };

afterEach(() => {
  vi.useRealTimers();
});

describe("the firm's day", () => {
  it("is the day it is in the firm's zone", () => {
    expect(todayIn("America/New_York", NY_EVENING)).toBe("2026-11-27");
    expect(todayIn("Australia/Sydney", SYDNEY_SMALL_HOURS)).toBe("2026-11-28");
    expect(todayIn(undefined, NY_EVENING)).toBe("2026-11-28"); // UTC, as before
    expect(calendarDayIn(SYDNEY_SMALL_HOURS, "Australia/Sydney")).toEqual({ year: 2026, month: 10, day: 28, weekday: 6 });
    expect(dayOf("2026-11-28T01:00:00.000Z", "America/New_York")).toBe("2026-11-27");
    expect(dayOf("not a time", "America/New_York")).toBe("not a time");
  });

  it("checks a configured zone once, with a plain message", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("New York")).toBe(false);
    expect(checkedTimeZone(" Europe/London ", "FIRM_TIME_ZONE")).toBe("Europe/London");
    expect(() => checkedTimeZone("Eastern", "FIRM_TIME_ZONE")).toThrow(/FIRM_TIME_ZONE must be an IANA time zone/);
  });
});

describe("a court date the receptionist hears", () => {
  it("counts weekdays and dates from the firm's day, not the server's", () => {
    // Saturday 1am in Sydney: Monday is two days off and escalates. Counted
    // from the server's Friday it was three days, and didn't.
    expect(parseHoursUntil("court on monday", SYDNEY_SMALL_HOURS, "Australia/Sydney")).toBe(48);
    // 8pm on the 27th in New York: "the 27th" is today, not next month.
    expect(parseHoursUntil("my hearing is the 27th", NY_EVENING, "America/New_York")).toBe(12);
    expect(parseHoursUntil("my hearing is friday", NY_EVENING, "America/New_York")).toBe(12);
    expect(parseHoursUntil("court on november 28", NY_EVENING, "America/New_York")).toBe(24);
  });

  function session(firmConfig: FirmConfig | undefined, now: Date, timeZone?: string) {
    const auditLog = new AuditLog();
    return new ReceptionistChatSession({
      matterId: "m1",
      module: criminalLawModule,
      router: new Router(new AccessControl(auditLog), auditLog),
      actor: { id: "r1", role: "receptionist" },
      now: () => now,
      ...(firmConfig ? { firmConfig } : {}),
      ...(timeZone ? { timeZone } : {}),
    });
  }

  const sydneyFirm: FirmConfig = {
    firmName: "Harbour Legal",
    attorneys: [],
    businessHours: { timezone: "Australia/Sydney", open: "09:00", close: "17:00", days: [1, 2, 3, 4, 5] },
    branding: { tone: "warm", greeting: "Hello." },
    jurisdictionRecordingConsent: "one-party-consent",
  };

  it("escalates from the firm config's zone when that's all there is", () => {
    const s = session(sydneyFirm, SYDNEY_SMALL_HOURS);
    s.greet();
    const result = s.handleMessage("I have court on Monday and I don't have a lawyer");
    expect(result.trace.triggers).toContain("court_appearance_imminent");
  });

  it("escalates from an explicit zone, mid-intake too", () => {
    const s = session(undefined, NY_EVENING, "America/New_York");
    s.greet();
    const result = s.handleMessage("my hearing is on the 27th");
    expect(result.trace.triggers).toContain("court_appearance_imminent");
  });

  it("carries on, on the server's day, if the configured zone isn't one", () => {
    const broken = { ...sydneyFirm, businessHours: { ...sydneyFirm.businessHours, timezone: "Sydney time" } };
    const s = session(broken, SYDNEY_SMALL_HOURS);
    expect(() => s.handleMessage("I have court tomorrow")).not.toThrow();
  });
});

describe("Coming due", () => {
  it("counts days from the firm's today", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NY_EVENING);
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "arraignment", date: "2026-11-27", source: "agent" });
    const [row] = new ReviewGateService(new WorkProductStore(), tracker, { timeZone: "America/New_York" }).listUpcomingDeadlines(attorney);
    // Due today, in New York — not "1 day overdue", which the UTC date said.
    expect(row).toMatchObject({ date: "2026-11-27", daysAway: 0, overdue: false });
  });
});

describe("the dates on a bill", () => {
  it("prints the day it was issued and paid where the firm is", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NY_EVENING);
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m-1", issuedBy: "a1", dueDate: "2026-12-27" });
    store.addLineItem(invoice.id, { description: "Consultation", source: "flat", quantityMilli: 1_000, unitAmountCents: 300_00 });
    store.send(invoice.id);
    store.recordPayment({ invoiceId: invoice.id, amountCents: 100_00, method: "check", recordedBy: "a1" });
    const rendered = renderInvoice({
      invoice: store.get(invoice.id)!,
      totals: store.totals(invoice.id),
      payments: store.paymentsFor(invoice.id),
      firm: { name: "Reyes & Okafor LLP", timeZone: "America/New_York" },
    });
    expect(rendered.text).toContain("Issued:  2026-11-27");
    expect(rendered.text).toMatch(/2026-11-27 {2}Check/);
    expect(rendered.text + rendered.html).not.toContain("2026-11-28");
  });
});

describe("closing a file", () => {
  it("dates the close, and the retention period, by the firm's day", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // New Year's Eve, 8pm in New York.
    vi.setSystemTime(new Date("2027-01-01T01:00:00Z"));
    const auditLog = new AuditLog();
    const store = new MatterStore();
    store.upsert("m-1", { title: "State v. Ruiz", status: "open" });
    const service = new MattersService({
      store,
      checker: new ConflictChecker(store),
      accessControl: new AccessControl(auditLog),
      auditLog,
      retentionYears: 7,
      timeZone: "America/New_York",
    });
    const { matter } = service.close(attorney, "m-1", { closingNote: "Concluded" });
    expect(matter.retentionUntil).toBe("2033-12-31");
    expect(service.listRetentionDue(attorney, new Date("2034-01-01T01:00:00Z"))).toHaveLength(1);
    expect(service.listRetentionDue(attorney, new Date("2033-12-31T04:00:00Z"))).toHaveLength(0); // still the 30th there
  });
});

describe("the public booking form", () => {
  const request: BookingSubmission = {
    name: "Pat Lee",
    email: "pat@example.com",
    matterType: "dui",
    preferredDate: "2026-11-27",
    preferredTime: "any",
  };

  it("takes today, in the evening, where the firm is", () => {
    expect(validateBookingSubmission(request, NY_EVENING, "America/New_York").preferredDate).toBe("2026-11-27");
    expect(() => validateBookingSubmission({ ...request, preferredDate: "2026-11-26" }, NY_EVENING, "America/New_York")).toThrow(
      /within the next/,
    );
    expect(validateBookingSubmission({ ...request, preferredDate: "2027-01-26" }, NY_EVENING, "America/New_York").preferredDate).toBe(
      "2027-01-26",
    );
  });
});

describe("the calendar file", () => {
  it("keeps this morning's appointment in a zone ahead of UTC", () => {
    const scheduling = new SchedulingService();
    // 9am Saturday in Sydney; it's noon there now, but still Friday in UTC... until 1pm.
    scheduling.scheduleConsultation(attorney, { matterId: "m-1", startTime: new Date("2026-11-27T22:00:00Z"), attorneyId: "a1" });
    const now = new Date("2026-11-28T01:00:00Z");
    const exportFor = (timeZone?: string) =>
      new CalendarExportService({ scheduling, auditLog: new AuditLog(), ...(timeZone ? { timeZone } : {}) }).export(attorney, { now });
    expect(exportFor("Australia/Sydney").appointmentCount).toBe(1);
    expect(exportFor(undefined).appointmentCount).toBe(0); // UTC's midnight dropped it
  });
});
