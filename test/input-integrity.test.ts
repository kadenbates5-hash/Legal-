import { describe, expect, it } from "vitest";
import { SchedulingService, SchedulingError } from "../src/core/scheduling.js";
import { InvoiceStore, InvoicingError, type LineItemSource } from "../src/core/invoicing.js";
import { renderInvoice } from "../src/core/invoice-render.js";
import { MatterStore, type Matter, type PartyRole } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { StaffScheduleStore, type StaffScheduleStatus } from "../src/core/staff-schedule.js";
import { isCalendarDate } from "../src/core/calendar-date.js";
import { DocumentStore, normalizedBase64, normalizedContentType, normalizedFileName } from "../src/core/document-store.js";
import { StaffScheduleService, MAX_SCHEDULE_NOTE_LENGTH } from "../src/review-ui/staff-schedule-service.js";
import { MessagingService } from "../src/review-ui/messaging-service.js";
import { MessagingStore, MAX_MESSAGE_LENGTH, ANNOUNCEMENTS_CONVERSATION_ID } from "../src/core/messaging.js";
import { ClientMessageStore } from "../src/core/client-messages.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { AuthService } from "../src/core/auth.js";
import { AuditLog } from "../src/core/audit.js";
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

  function scheduleService() {
    const auth = new AuthService();
    auth.createUser({ username: "atty", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "para", password: "correct-horse", role: "paralegal", actorId: "p1" });
    auth.createUser({ username: "cli", password: "correct-horse", role: "client", actorId: "c1" });
    const auditLog = new AuditLog();
    const isStaffMember = (id: string) => auth.listUsers().some((u) => u.actorId === id && u.role !== "client");
    return { service: new StaffScheduleService(new StaffScheduleStore(), { isStaffMember, auditLog }), auditLog };
  }

  it("won't put someone who isn't on staff on the day's list", () => {
    const { service } = scheduleService();
    expect(() => service.setEntry(attorney, "ghost", "2026-11-30", "in_office")).toThrow(/no user on staff with id 'ghost'/);
    expect(() => service.setEntry(attorney, "c1", "2026-11-30", "in_office")).toThrow(/no user on staff/);
    expect(() => service.setEntry(attorney, "P1", "2026-11-30", "in_office")).toThrow(/no user on staff/); // ids are exact
    expect(service.setEntry(attorney, "p1", "2026-11-30", "out").status).toBe("out");
    expect(service.listForDate(attorney, "2026-11-30").map((e) => e.actorId)).toEqual(["p1"]);
  });

  it("keeps a note to a note, trimmed", () => {
    const { service } = scheduleService();
    expect(() => service.setEntry(attorney, "a1", "2026-11-30", "out", "x".repeat(MAX_SCHEDULE_NOTE_LENGTH + 1))).toThrow(
      /at most 200 characters/,
    );
    expect(service.setEntry(attorney, "a1", "2026-11-30", "out", "  in court until 2  ").note).toBe("in court until 2");
    expect(service.setEntry(attorney, "a1", "2026-12-01", "out", "   ").note).toBeUndefined();
  });

  it("records an attorney changing a colleague's day, but not anyone's own", () => {
    const { service, auditLog } = scheduleService();
    const paralegal: Actor = { id: "p1", role: "paralegal" };
    service.setEntry(paralegal, "p1", "2026-11-30", "remote");
    service.setEntry(attorney, "a1", "2026-11-30", "in_office");
    expect(auditLog.read("attorney")).toHaveLength(0);

    service.setEntry(attorney, "p1", "2026-11-30", "out");
    service.removeEntry(attorney, "p1", "2026-11-30");
    service.removeEntry(attorney, "p1", "2026-11-30"); // nothing left to remove: no entry for it
    expect(auditLog.read("attorney").map((e) => [e.action, e.detail])).toEqual([
      ["staff_schedule_set_for_colleague", "actor=p1 date=2026-11-30 status=out"],
      ["staff_schedule_removed_for_colleague", "actor=p1 date=2026-11-30"],
    ]);
  });
});

describe("staff messages: who a conversation can include", () => {
  function messaging() {
    const auth = new AuthService();
    auth.createUser({ username: "atty", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "para", password: "correct-horse", role: "paralegal", actorId: "p1" });
    auth.createUser({ username: "cli", password: "correct-horse", role: "client", actorId: "c1" });
    return { auth, service: new MessagingService(new MessagingStore(), auth) };
  }

  it("won't start a conversation with an id nobody holds yet, which its future holder would inherit", () => {
    const { auth, service } = messaging();
    expect(() => service.startDirectConversation(attorney, "p2")).toThrow(/no user on staff with id 'p2'/);
    // Had it been allowed, the account created later with that id would read it.
    auth.createUser({ username: "newhire", password: "correct-horse", role: "paralegal", actorId: "p2" });
    expect(service.listConversations({ id: "p2", role: "paralegal" }).filter((c) => c.kind !== "announcement")).toHaveLength(0);
    expect(service.startDirectConversation(attorney, "p2").participants.map((p) => p.actorId)).toEqual(["a1", "p2"]);
  });

  it("won't address a client account, which can never read staff messages", () => {
    const { service } = messaging();
    expect(() => service.startDirectConversation(attorney, "c1")).toThrow(/no user on staff/);
    expect(() => service.createGroup(attorney, "Team", ["p1", "c1"])).toThrow(/no user on staff with id 'c1'/);
    const group = service.createGroup(attorney, "Team", ["p1"]);
    expect(() => service.addMember(attorney, group.id, "ghost")).toThrow(/no user on staff/);
    expect(service.addMember(attorney, group.id, "a1").participants.length).toBeGreaterThan(0);
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

describe("messages: a size a message can be", () => {
  // Every message lives in the one state document rewritten on each save,
  // which Postgres caps at 1 GB — and a client account can post to its thread.
  const long = "x".repeat(MAX_MESSAGE_LENGTH + 1);

  it("refuses a client message too long to be one, pointing at an upload instead", () => {
    const store = new ClientMessageStore();
    const post = (body: string) => store.post({ matterId: "m1", authorId: "c1", authorRole: "client", body });
    expect(() => post(long)).toThrow(/at most 10,000 characters — for anything longer, upload it as a document/);
    expect(store.listForMatter("m1")).toHaveLength(0);
    expect(post(`  ${"y".repeat(MAX_MESSAGE_LENGTH)}  `).body).toHaveLength(MAX_MESSAGE_LENGTH); // trimmed first
  });

  it("refuses the same in staff conversations and announcements", () => {
    const store = new MessagingStore();
    expect(() => store.postMessage(ANNOUNCEMENTS_CONVERSATION_ID, "a1", long)).toThrow(/at most 10,000 characters/);
    expect(() => store.postMessage(ANNOUNCEMENTS_CONVERSATION_ID, "a1", "   ")).toThrow(/must not be empty/);
    expect(store.postMessage(ANNOUNCEMENTS_CONVERSATION_ID, "a1", "Office closes at 3 on Friday.").body).toBe(
      "Office closes at 3 on Friday.",
    );
  });
});

describe("saved research references: a bookmark's size, and only a web link", () => {
  const save = (over: Partial<{ citation: string; title: string; url: string; note: string }>) =>
    new ResearchLibrary().save({ matterId: "m1", citation: "Miranda v. Arizona, 384 U.S. 436", title: "Miranda", savedBy: "p1", ...over });

  it("keeps only http and https links", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "courtlistener.com/opinion/1"]) {
      expect(() => save({ url: bad }), bad).toThrow(/web address/);
    }
    expect(save({ url: " https://www.courtlistener.com/opinion/107252/miranda-v-arizona/ " }).url).toBe(
      "https://www.courtlistener.com/opinion/107252/miranda-v-arizona/",
    );
    expect(save({ url: "  " }).url).toBeUndefined();
  });

  it("refuses fields far past what a citation, title or note is", () => {
    expect(() => save({ citation: "c".repeat(1_001) })).toThrow(/a citation can be at most 1,000/);
    expect(() => save({ title: "t".repeat(1_001) })).toThrow(/a title can be at most 1,000/);
    expect(save({ citation: Array.from({ length: 20 }, (_, i) => `${100 + i} U.S. ${400 + i}`).join(", ") }).citation).toContain("119 U.S.");
    expect(() => save({ note: "n".repeat(5_001) })).toThrow(/a note can be at most 5,000/);
    expect(() => save({ url: `https://x.example/${"p".repeat(2_000)}` })).toThrow(/at most 2,000/);
    expect(save({ note: "  key holding on page 444  " }).note).toBe("key holding on page 444");
  });
});

describe("uploaded documents: the bytes themselves", () => {
  const upload = (content: string) =>
    new DocumentStore().upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content, uploadedBy: "a1" });

  it("refuses content that isn't base64, which used to download as a quietly corrupt file", () => {
    for (const bad of ["not base64 at all!", "aGk", "aGk==x", "<script>", "aG=k"]) {
      expect(() => upload(bad), JSON.stringify(bad)).toThrow(/encoded as base64/);
    }
  });

  it("takes off a data-URL prefix and line breaks, which say plainly what was meant", () => {
    const bytes = Buffer.from("%PDF-1.4 a real file");
    const b64 = bytes.toString("base64");
    const wrapped = b64.replace(/(.{8})/g, "$1\r\n");
    for (const sent of [`data:application/pdf;base64,${b64}`, wrapped, ` ${b64}\n`]) {
      const doc = upload(sent);
      expect(Buffer.from(doc.content, "base64").equals(bytes)).toBe(true);
      expect(doc.size).toBe(bytes.length);
    }
    expect(normalizedBase64("")).toBe(""); // an empty file is still a file
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
