import { describe, expect, it } from "vitest";
import { SchedulingService, SchedulingError } from "../src/core/scheduling.js";
import { InvoiceStore, InvoicingError, type LineItemSource } from "../src/core/invoicing.js";
import { renderInvoice } from "../src/core/invoice-render.js";
import { MatterStore, type Matter, type PartyRole } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { StaffScheduleStore, type StaffScheduleStatus } from "../src/core/staff-schedule.js";
import { isCalendarDate } from "../src/core/calendar-date.js";
import { DocumentStore, normalizedContentType, normalizedFileName } from "../src/core/document-store.js";
import type { Actor } from "../src/core/types.js";

/**
 * Found by sending each write route the values a careless or hostile
 * caller would: every one of these was stored as sent.
 */
const attorney: Actor = { id: "a1", role: "attorney" };

describe("appointments: a length that decides what overlaps", () => {
  const book = (scheduling: SchedulingService, start: string, durationMinutes?: number) =>
    scheduling.scheduleConsultation(attorney, {
      matterId: "m1",
      attorneyId: "a1",
      startTime: new Date(start),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    });

  it("refuses a negative duration, which overlapped nothing and so slipped past double-booking", () => {
    const scheduling = new SchedulingService();
    book(scheduling, "2026-12-01T15:00:00Z", 60);
    expect(() => book(scheduling, "2026-12-01T15:15:00Z", -30)).toThrow(/between 1 and 1440 minutes/);
    // The overlap rule still holds for an honest one.
    expect(() => book(scheduling, "2026-12-01T15:15:00Z", 30)).toThrow(SchedulingError);
  });

  it("refuses a duration that would block the attorney's calendar for good", () => {
    const scheduling = new SchedulingService();
    for (const minutes of [1e9, 1441, 0, 2.5, Number.NaN]) {
      let caught: unknown;
      try {
        book(scheduling, "2026-12-02T15:00:00Z", minutes);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(minutes)).toBeInstanceOf(SchedulingError);
      expect((caught as SchedulingError).kind, String(minutes)).toBe("invalid");
    }
    // A later booking for the same attorney is unaffected.
    expect(book(scheduling, "2027-03-01T15:00:00Z", 1440).durationMinutes).toBe(1440);
  });

  it("says a start time isn't one, rather than 'Invalid time value'", () => {
    const scheduling = new SchedulingService();
    expect(() => book(scheduling, "not a date")).toThrow(/start time must be a date and time/);
    const appt = book(scheduling, "2026-12-03T15:00:00Z");
    expect(() => scheduling.reschedule(attorney, appt.id, { newStartTime: new Date("soon") })).toThrow(
      /new start time must be a date and time/,
    );
  });
});

describe("invoice lines: everything the total adds up is printed, exactly", () => {
  const draft = () => {
    const store = new InvoiceStore();
    return { store, invoice: store.createDraft({ matterId: "m1", issuedBy: "a1" }) };
  };
  const line = { description: "Motion", source: "flat" as LineItemSource, quantityMilli: 1000, unitAmountCents: 50000 };

  it("refuses a category the bill has no heading for", () => {
    const { store, invoice } = draft();
    expect(() => store.addLineItem(invoice.id, { ...line, source: "other" as LineItemSource })).toThrow(
      /must be time, expense or flat/,
    );
  });

  it("refuses amounts too large to add up to the cent", () => {
    const { store, invoice } = draft();
    expect(() => store.addLineItem(invoice.id, { ...line, unitAmountCents: 1e16 })).toThrow(InvoicingError);
    expect(() => store.addLineItem(invoice.id, { ...line, quantityMilli: 1e18 })).toThrow(InvoicingError);
    expect(() => store.addLineItem(invoice.id, { ...line, quantityMilli: 1e9, unitAmountCents: 1e9 })).toThrow(
      /hold exactly/,
    );
    expect(store.addLineItem(invoice.id, line).amountCents).toBe(50000);
  });

  it("refuses a 'date worked' that isn't a date", () => {
    const { store, invoice } = draft();
    expect(() => store.addLineItem(invoice.id, { ...line, source: "time", workedOn: "whenever" })).toThrow(/YYYY-MM-DD/);
    expect(store.addLineItem(invoice.id, { ...line, source: "time", workedOn: "2026-07-28" }).workedOn).toBe("2026-07-28");
  });

  it("prints a line already saved under an unknown category, rather than totalling it unseen", () => {
    const { store, invoice } = draft();
    store.addLineItem(invoice.id, { ...line, description: "Court filing fee", source: "expense", unitAmountCents: 5000 });
    // What a line saved before the check looks like after a reload.
    const snapshot = store.toSnapshot();
    const saved = snapshot.invoices[0]!;
    saved.lineItems = [
      ...saved.lineItems,
      { ...saved.lineItems[0]!, id: "line_old", description: "Hidden surcharge", source: "other" as LineItemSource, amountCents: 90000, unitAmountCents: 90000 },
    ];
    const reloaded = InvoiceStore.fromSnapshot(snapshot);
    const rendered = renderInvoice({
      invoice: reloaded.get(invoice.id)!,
      totals: reloaded.totals(invoice.id),
      payments: [],
      firm: { name: "Test Firm" },
    });
    expect(rendered.text).toContain("Hidden surcharge");
    expect(rendered.html).toContain("Hidden surcharge");
    expect(rendered.text).toContain("$950.00");
  });
});

describe("matter records: the fields every conflicts check reads", () => {
  const base = { title: "People v. Vance", status: "open" as const };

  it("reads a role forgivingly, and refuses one that names no side", () => {
    const store = new MatterStore();
    const saved = store.upsert("m1", { ...base, parties: [{ name: " Quill Hartley ", role: "Adverse" as PartyRole, note: undefined, email: undefined, phone: undefined }] });
    expect(saved.parties[0]).toMatchObject({ name: "Quill Hartley", role: "adverse" });
    expect(() =>
      store.upsert("m2", { ...base, parties: [{ name: "Imogen Pryce", role: "opposing party" as PartyRole, note: undefined, email: undefined, phone: undefined }] }),
    ).toThrow(/must be client, adverse or related/);
    expect(() =>
      store.upsert("m3", { ...base, parties: [{ name: "  ", role: "client", note: undefined, email: undefined, phone: undefined }] }),
    ).toThrow(/needs a name/);
    expect(store.get("m2")).toBeUndefined();
  });

  it("refuses a status that isn't one, and a key date that isn't a date", () => {
    const store = new MatterStore();
    expect(store.upsert("m1", { ...base, status: "Open" as Matter["status"] }).status).toBe("open");
    expect(() => store.upsert("m2", { ...base, status: "active" as Matter["status"] })).toThrow(/prospective, open or closed/);
    expect(() => store.upsert("m3", { ...base, keyDates: [{ label: "Trial", date: "someday" }] })).toThrow(/YYYY-MM-DD/);
    expect(() => store.upsert("m4", { ...base, keyDates: [{ label: "", date: "2026-12-01" }] })).toThrow(/needs a label/);
  });

  it("screens a party saved with an unrecognised role as possibly either side, never as informational", () => {
    // A record written before roles were checked.
    const matters = MatterStore.fromSnapshot([
      {
        matterId: "m-old",
        title: "People v. Vance",
        status: "open",
        keyDates: [],
        parties: [{ name: "Quill Hartley", role: "Adverse" as PartyRole, note: undefined, email: undefined, phone: undefined }],
        openedAt: "2025-01-01T00:00:00.000Z",
        closedAt: undefined,
        updatedAt: "2025-01-01T00:00:00.000Z",
      } as unknown as Matter,
    ]);
    const checker = new ConflictChecker(matters);
    // "Adverse" is read as adverse: taking Hartley on as a client is a Rule 1.7 conflict.
    const asClient = checker.check({ names: ["Quill Hartley"], roleByName: { "Quill Hartley": "client" } });
    expect(asClient.hits[0]!.severity).toBe("direct");
    expect(asClient.requiresAttorneyReview).toBe(true);

    // A role naming no side at all could be either, so both directions flag.
    const unknown = MatterStore.fromSnapshot([
      { ...matters.get("m-old")!, parties: [{ name: "Imogen Pryce", role: "opposing party" as PartyRole, note: undefined, email: undefined, phone: undefined }] },
    ]);
    const either = new ConflictChecker(unknown);
    for (const role of ["client", "adverse"] as const) {
      const result = either.check({ names: ["Imogen Pryce"], roleByName: { "Imogen Pryce": role } });
      expect(result.hits[0]!.severity, role).toBe("direct");
    }
  });
});

describe("the staff schedule", () => {
  it("refuses a status the panel can't show and a day no view will find", () => {
    const store = new StaffScheduleStore();
    expect(() => store.setEntry("a1", "2026-11-30", "office" as StaffScheduleStatus)).toThrow(/in_office, remote or out/);
    expect(() => store.setEntry("a1", "garbage", "remote")).toThrow(/YYYY-MM-DD/);
    expect(store.setEntry("a1", "2026-11-30", "remote").status).toBe("remote");
  });
});

describe("uploaded documents: what goes back out in a header", () => {
  it("stores a file's type as type/subtype, and anything else as plain bytes", () => {
    expect(normalizedContentType("Application/PDF")).toBe("application/pdf");
    expect(normalizedContentType("text/plain; charset=utf-8")).toBe("text/plain");
    for (const bad of ["text/html\r\nX-Evil: 1", "", "pdf", "a/b/c", "image/ png"]) {
      expect(normalizedContentType(bad), JSON.stringify(bad)).toBe("application/octet-stream");
    }
  });

  it("keeps a file name on one line, and refuses one that's only control characters", () => {
    const store = new DocumentStore();
    const doc = store.upload({ matterId: "m1", fileName: "Plea\r\n  offer.pdf", contentType: "text/html\nX: 1", content: "aGk=", uploadedBy: "a1" });
    expect(doc.fileName).toBe("Plea offer.pdf");
    expect(doc.contentType).toBe("application/octet-stream");
    expect(normalizedFileName("x".repeat(300))).toHaveLength(255);
    expect(() => store.upload({ matterId: "m1", fileName: "\r\n", contentType: "", content: "aGk=", uploadedBy: "a1" })).toThrow(
      /fileName is required/,
    );
  });
});

describe("isCalendarDate", () => {
  it("knows a real day from something shaped like one", () => {
    for (const ok of ["2024-02-29", "2026-12-31", "1900-01-01"]) expect(isCalendarDate(ok), ok).toBe(true);
    for (const bad of ["2026-02-29", "2026-02-30", "2026-7-28", "2026-13-01", "1899-12-31", "someday", "", 20260728]) {
      expect(isCalendarDate(bad), String(bad)).toBe(false);
    }
  });
});
