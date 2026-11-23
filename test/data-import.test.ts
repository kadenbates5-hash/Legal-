import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { CsvError, detectDelimiter, parseCsv } from "../src/core/csv.js";
import {
  DataImportError,
  detectColumns,
  guessSource,
  parseImportDate,
  parseImportHours,
  planImport,
  type ImportContext,
  type ImportPerson,
} from "../src/core/data-import.js";
import { MatterStore } from "../src/core/matters.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { ImportService } from "../src/review-ui/import-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const NOW = new Date("2026-11-23T15:00:00Z");

const PEOPLE: ImportPerson[] = [
  { actorId: "att-ada", username: "ada", displayName: "Ada Brooks", role: "attorney", disabled: false },
  { actorId: "para-sam", username: "sam", displayName: "Sam Ortiz", role: "paralegal", disabled: false },
  { actorId: "rec-kim", username: "kim", displayName: "Kim Park", role: "receptionist", disabled: false },
  { actorId: "att-old", username: "lou", displayName: "Lou Grant", role: "attorney", disabled: true },
];

function ctx(overrides: Partial<ImportContext> = {}): ImportContext {
  return { matters: new MatterStore(), people: PEOPLE, billingEntries: [], now: NOW, ...overrides };
}

describe("parseCsv", () => {
  it("reads quoted commas, doubled quotes and line breaks inside a value", () => {
    const csv = 'Name,Notes\r\n"Smith, John","He said ""hi""\nthen left"\r\nAcme,plain\r\n';
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["Name", "Notes"]);
    expect(parsed.records.map((r) => r.values)).toEqual([
      ["Smith, John", 'He said "hi"\nthen left'],
      ["Acme", "plain"],
    ]);
    // The second record starts on line 4 because the first spans two lines.
    expect(parsed.records.map((r) => r.line)).toEqual([2, 4]);
  });

  it("turns a CRLF inside a quoted value into a plain newline", () => {
    const parsed = parseCsv('a,b\r\n"first\r\nsecond",x\r\n"y",z\r\n');
    expect(parsed.records.map((r) => r.values)).toEqual([
      ["first\nsecond", "x"],
      ["y", "z"],
    ]);
    expect(parsed.records.map((r) => r.line)).toEqual([2, 4]);
  });

  it("strips a byte-order mark and skips blank rows", () => {
    const parsed = parseCsv("﻿a,b\n\n1,2\n,\n3,4");
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.records.map((r) => r.values)).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("detects semicolon- and tab-separated files", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter('"x;y",b\n')).toBe(",");
    expect(parseCsv("Matter;Hours\n12;1,5").records[0]!.values).toEqual(["12", "1,5"]);
  });

  it("pads short rows and accepts bare CR line endings", () => {
    const parsed = parseCsv("a,b,c\r1\r2,3");
    expect(parsed.records.map((r) => r.values)).toEqual([
      ["1", "", ""],
      ["2", "3", ""],
    ]);
  });

  it("refuses an unterminated quote, naming the line", () => {
    expect(() => parseCsv('a,b\n1,"never ends\n2,3')).toThrow(/line 2/);
    expect(() => parseCsv('a,b\n1,"never ends')).toThrow(CsvError);
  });

  it("refuses an empty file and one with too many rows", () => {
    expect(() => parseCsv("")).toThrow(/empty/);
    const big = "a\n" + Array.from({ length: 11 }, (_, i) => String(i)).join("\n");
    expect(() => parseCsv(big, { maxRecords: 10 })).toThrow(/more than 10 rows/);
    expect(parseCsv(big, { maxRecords: 11 }).records).toHaveLength(11);
  });
});

describe("value parsing", () => {
  it("reads the date shapes exports use", () => {
    expect(parseImportDate("2026-07-28")).toBe("2026-07-28");
    expect(parseImportDate("2026-07-28 14:30:00")).toBe("2026-07-28");
    expect(parseImportDate("2026/07/28")).toBe("2026-07-28");
    expect(parseImportDate("7/28/2026")).toBe("2026-07-28");
    expect(parseImportDate("07/28/26")).toBe("2026-07-28");
    expect(parseImportDate("7/28/2026 10:00 AM")).toBe("2026-07-28");
    expect(parseImportDate("28/07/2026")).toBe("2026-07-28"); // day > 12 can only be day-first
    expect(parseImportDate("28-Jul-2026")).toBe("2026-07-28");
    expect(parseImportDate("Jul 28, 2026")).toBe("2026-07-28");
    expect(parseImportDate("September 3 2026")).toBe("2026-09-03");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parseImportDate("2026-02-30")).toBeUndefined();
    expect(parseImportDate("13/13/2026")).toBeUndefined();
    expect(parseImportDate("yesterday")).toBeUndefined();
    expect(parseImportDate("")).toBeUndefined();
  });

  it("reads hours as decimals, h:mm and h/m forms", () => {
    expect(parseImportHours("1.5")).toBe(1.5);
    expect(parseImportHours("1,5")).toBe(1.5);
    expect(parseImportHours("1:30")).toBe(1.5);
    expect(parseImportHours("0:06")).toBe(0.1);
    expect(parseImportHours("1h 30m")).toBe(1.5);
    expect(parseImportHours("90m")).toBe(1.5);
    expect(parseImportHours("45 min")).toBe(0.75);
    expect(parseImportHours("2 hours")).toBe(2);
    expect(parseImportHours("lots")).toBeUndefined();
    expect(parseImportHours("")).toBeUndefined();
  });
});

describe("column detection", () => {
  it("maps Clio-, MyCase- and PracticePanther-style headers", () => {
    const clio = detectColumns(["Display Number", "Description", "Client", "Responsible Attorney", "Status", "Open Date"], "matters");
    expect(clio["matterId"]).toBe(0);
    expect(clio["description"]).toBe(1);
    expect(clio["client"]).toBe(2);
    expect(clio["responsibleAttorney"]).toBe(3);
    expect(clio["openedOn"]).toBe(5);

    const mycase = detectColumns(["Case Name", "Case Number", "Lead Attorney", "Contact", "Date Opened"], "matters");
    expect(mycase["title"]).toBe(0);
    expect(mycase["caseNumber"]).toBe(1);
    expect(mycase["responsibleAttorney"]).toBe(2);
    expect(mycase["client"]).toBe(3);

    const time = detectColumns(["Date", "Matter", "Billed By", "Hours", "Description", "Billed"], "time_entries");
    expect(time).toMatchObject({ date: 0, matter: 1, timekeeper: 2, hours: 3, description: 4, billed: 5 });
  });

  it("uses each column for one field only, and honours overrides", () => {
    // "Status" would match `billed`; an override can say the file has no such column.
    const cols = detectColumns(["Date", "Matter", "User", "Quantity", "Note", "Status"], "time_entries", { billed: "" });
    expect(cols["billed"]).toBeUndefined();
    const moved = detectColumns(["Date", "Matter", "User", "Quantity", "Note", "Invoice #"], "time_entries", { billed: "Invoice #" });
    expect(moved["billed"]).toBe(5);
    expect(() => detectColumns(["a"], "time_entries", { date: "Nope" })).toThrow(DataImportError);
  });

  it("guesses the source from column names, cosmetically", () => {
    expect(guessSource(["Display Number", "Client"])).toBe("Clio");
    expect(guessSource(["Case Name", "Lead Attorney"])).toBe("MyCase");
    expect(guessSource(["Matter Name", "Account"])).toBe("PracticePanther");
    expect(guessSource(["Title", "Client"])).toBeUndefined();
  });
});

describe("planning a matters import", () => {
  const CLIO = [
    "Display Number,Description,Client,Opposing Party,Responsible Attorney,Status,Open Date,Close Date,Client Email,Client Phone",
    '00012-Ruiz,State v. Ruiz,"Ruiz, Maria",The State,Ada Brooks,Open,03/14/2025,,maria@example.com,(555) 010-2030',
    "00013-Chen,Chen DUI,Wei Chen,,Nobody Known,Closed,1/2/2024,6/30/2024,,",
    "00014-Bad/Id,Something,Pat Doe,,,,,,,",
  ].join("\n");

  it("creates, assigns and dates matters, and explains every choice", () => {
    const { plan, matters } = planImport("matters", CLIO, ctx({ retentionYears: 7 }));
    expect(plan.sourceGuess).toBe("Clio");
    expect(plan.counts).toEqual({ create: 2, skip: 0, error: 1 });

    const ruiz = matters.find((m) => m.matterId === "00012-Ruiz")!;
    expect(ruiz.input.title).toBe("State v. Ruiz");
    expect(ruiz.input.responsibleAttorneyId).toBe("att-ada");
    expect(ruiz.input.parties).toEqual([
      { name: "Ruiz, Maria", role: "client", note: undefined, email: "maria@example.com", phone: "+15550102030" },
      { name: "The State", role: "adverse", note: undefined, email: undefined, phone: undefined },
    ]);
    expect(ruiz.openedAt).toBe("2025-03-14T00:00:00.000Z");

    const chen = matters.find((m) => m.matterId === "00013-Chen")!;
    expect(chen.input.status).toBe("closed");
    expect(chen.closedAt).toBe("2024-06-30T00:00:00.000Z");
    expect(chen.input.retentionUntil).toBe("2031-06-30");
    expect(chen.input.closingNote).toMatch(/Imported as closed from a Clio export/);
    expect(chen.input.responsibleAttorneyId).toBeUndefined();
    const chenRow = plan.rows.find((r) => r.matterId === "00013-Chen")!;
    expect(chenRow.warnings.join(" ")).toMatch(/no attorney account matches 'Nobody Known'/);

    const bad = plan.rows.find((r) => r.line === 4)!;
    expect(bad.action).toBe("error");
    expect(bad.reason).toMatch(/character Docket can't use/);
  });

  it("never overwrites an existing matter", () => {
    const store = new MatterStore();
    store.upsert("00012-Ruiz", { title: "Already here", parties: [{ name: "Someone Else", role: "client", note: undefined, email: undefined, phone: undefined }] });
    const { plan, matters } = planImport("matters", CLIO, ctx({ matters: store }));
    const row = plan.rows.find((r) => r.matterId === "00012-Ruiz")!;
    expect(row.action).toBe("skip");
    expect(row.reason).toMatch(/left unchanged/);
    expect(matters.map((m) => m.matterId)).not.toContain("00012-Ruiz");
  });

  it("flags duplicates within the file", () => {
    const csv = "Matter Number,Matter Name,Client\nA-1,One,X Y\nA-1,Two,Z W";
    const { plan } = planImport("matters", csv, ctx());
    expect(plan.rows[1]).toMatchObject({ action: "error", reason: "same matter number as line 2" });
  });

  it("derives an id from the name when there's no number column, and won't collide with a different matter", () => {
    const store = new MatterStore();
    store.upsert("smith-v-jones", { title: "Smith v. Jones (old)" });
    const csv = "Matter Name,Client\nSmith v. Jones,Al Smith\nBrown Estate,Bea Brown";
    const { plan, matters } = planImport("matters", csv, ctx({ matters: store }));
    expect(plan.notes.join(" ")).toMatch(/no matter-number column/);
    expect(plan.rows[0]).toMatchObject({ action: "error" });
    expect(plan.rows[0]!.reason).toMatch(/already belongs to 'Smith v. Jones \(old\)'/);
    expect(matters.map((m) => m.matterId)).toEqual(["brown-estate"]);
  });

  it("re-importing the same name-derived file skips rather than errors", () => {
    const store = new MatterStore();
    store.upsert("brown-estate", { title: "Brown Estate" });
    const { plan } = planImport("matters", "Matter Name,Client\nBrown Estate,Bea Brown", ctx({ matters: store }));
    expect(plan.rows[0]).toMatchObject({ action: "skip" });
  });

  it("refuses to import a matter as closed while trust funds are held under its id", () => {
    const csv = "Matter Number,Matter Name,Status\nT-1,Trust held,Closed";
    const { plan } = planImport("matters", csv, ctx({ trustBalanceCents: (id) => (id === "T-1" ? 5000 : 0) }));
    expect(plan.rows[0]!.action).toBe("error");
    expect(plan.rows[0]!.reason).toMatch(/holds client funds/);
  });

  it("screens new matters against existing records and each other, and requires acknowledgement", () => {
    const store = new MatterStore();
    store.upsert("m-existing", {
      title: "Existing client matter",
      status: "open",
      parties: [{ name: "Acme Corporation", role: "client", note: undefined, email: undefined, phone: undefined }],
    });
    const csv = [
      "Matter Number,Matter Name,Client,Adverse Party",
      "N-1,Suing Acme,Jo Bloggs,\"Acme, Inc.\"",
      "N-2,Bloggs is adverse here,Rita Ray,Jo Bloggs",
      "N-3,No overlap,Quinn Zed,",
    ].join("\n");
    const { plan } = planImport("matters", csv, ctx({ matters: store }));
    expect(plan.needsConflictAcknowledgement).toBe(true);
    const n1 = plan.rows.find((r) => r.matterId === "N-1")!;
    expect(n1.conflicts!.some((c) => c.matterId === "m-existing" && c.severity === "direct")).toBe(true);
    expect(n1.conflicts!.some((c) => c.matterId === "N-2")).toBe(true);
    expect(plan.rows.find((r) => r.matterId === "N-3")!.conflicts).toBeUndefined();
  });

  it("keeps notes about what the file lacks", () => {
    const { plan } = planImport("matters", "Matter Name\nLonely", ctx());
    expect(plan.notes.join(" ")).toMatch(/No client column/);
    expect(plan.notes.join(" ")).toMatch(/No adverse-party column/);
    expect(plan.rows[0]!.warnings.join(" ")).toMatch(/no client named/);
  });

  it("reports a missing required column instead of guessing", () => {
    const { plan } = planImport("matters", "Client,Phone\nA B,555", ctx());
    expect(plan.missingRequired).toEqual(["Matter number or Matter name"]);
    expect(plan.rows).toEqual([]);
  });

  it("keeps a title on one line even when the cell held line breaks", () => {
    const { matters } = planImport("matters", 'Matter Number,Matter Name,Court\nL-1,"State v.\nLee","Superior\r\nCourt"', ctx());
    expect(matters[0]!.input.title).toBe("State v. Lee");
    expect(matters[0]!.input.court).toBe("Superior Court");
  });

  it("strips characters the party editor uses for contact details", () => {
    const { matters, plan } = planImport("matters", "Matter Number,Client\nX-1,Jo <jo@x.com>", ctx());
    expect(matters[0]!.input.parties![0]!.name).toBe("Jo jo@x.com");
    expect(plan.rows[0]!.warnings.join(" ")).toMatch(/removed < > \[ \]/);
  });
});

describe("planning a time-entries import", () => {
  function withMatters(): MatterStore {
    const store = new MatterStore();
    store.upsert("00012-Ruiz", { title: "State v. Ruiz" });
    store.upsert("00013-Chen", { title: "Chen DUI" });
    return store;
  }

  it("imports unbilled time, credited to the right person, matched by number, name or Clio's 'number-name' form", () => {
    const csv = [
      "Date,Matter,User,Quantity,Description,Status,Rate",
      "11/02/2026,00012-Ruiz,Ada Brooks,1.5,Arraignment prep,Unbilled,350",
      "11/03/2026,Chen DUI,sam,0:30,Call with client,Unbilled,150",
      '11/04/2026,"00013-Chen - Chen DUI","Brooks, Ada",2,Motion research,,350',
    ].join("\n");
    const { plan, timeEntries } = planImport("time_entries", csv, ctx({ matters: withMatters() }));
    expect(plan.counts).toEqual({ create: 3, skip: 0, error: 0 });
    expect(plan.hoursToCreate).toBe(4);
    expect(timeEntries).toEqual([
      { matterId: "00012-Ruiz", actorId: "att-ada", date: "2026-11-02", hours: 1.5, description: "Arraignment prep" },
      { matterId: "00013-Chen", actorId: "para-sam", date: "2026-11-03", hours: 0.5, description: "Call with client" },
      { matterId: "00013-Chen", actorId: "att-ada", date: "2026-11-04", hours: 2, description: "Motion research" },
    ]);
    expect(plan.notes.join(" ")).toMatch(/Rates and amounts in the file aren't imported/);
  });

  it("skips time already billed in the old system, and warns when the file can't say", () => {
    const store = withMatters();
    const billed = "Date,Matter,User,Hours,Description,Billed\n11/02/2026,00012-Ruiz,ada,1,Prep,Yes\n11/03/2026,00012-Ruiz,ada,1,More,No";
    const { plan } = planImport("time_entries", billed, ctx({ matters: store }));
    expect(plan.rows[0]).toMatchObject({ action: "skip" });
    expect(plan.rows[0]!.reason).toMatch(/already billed/);
    expect(plan.rows[1]).toMatchObject({ action: "create" });

    const silent = planImport("time_entries", "Date,Matter,User,Hours,Description\n11/02/2026,00012-Ruiz,ada,1,Prep", ctx({ matters: store }));
    expect(silent.plan.notes.join(" ")).toMatch(/doesn't say which entries were already billed/);

    const invoiceCol = planImport(
      "time_entries",
      "Date,Matter,User,Hours,Description,Invoice Number\n11/02/2026,00012-Ruiz,ada,1,Prep,INV-7\n11/02/2026,00012-Ruiz,ada,1,Other,",
      ctx({ matters: store }),
    );
    expect(invoiceCol.plan.rows.map((r) => r.action)).toEqual(["skip", "create"]);
  });

  it("refuses a billed value it can't read rather than guessing", () => {
    const { plan } = planImport("time_entries", "Date,Matter,User,Hours,Description,Billed\n11/02/2026,00012-Ruiz,ada,1,Prep,maybe", ctx({ matters: withMatters() }));
    expect(plan.rows[0]!.action).toBe("error");
    expect(plan.rows[0]!.reason).toMatch(/can't tell whether this entry was already billed/);
  });

  it("skips expenses and non-billable time, honouring an inverted 'Non-billable' column", () => {
    const csv = [
      "Date,Matter,User,Hours,Description,Type,Non-billable",
      "11/02/2026,00012-Ruiz,ada,1,Filing fee,ExpenseEntry,",
      "11/02/2026,00012-Ruiz,ada,1,Internal meeting,TimeEntry,Yes",
      "11/02/2026,00012-Ruiz,ada,1,Client call,TimeEntry,No",
    ].join("\n");
    const { plan } = planImport("time_entries", csv, ctx({ matters: withMatters() }));
    expect(plan.rows.map((r) => r.action)).toEqual(["skip", "skip", "create"]);
    expect(plan.rows[0]!.reason).toMatch(/expense/);
    expect(plan.rows[1]!.reason).toBe("marked non-billable");
  });

  it("only credits time to a matching attorney or paralegal account", () => {
    const csv = [
      "Date,Matter,User,Hours,Description,Billed",
      "11/02/2026,00012-Ruiz,Nobody Here,1,Work,No",
      "11/02/2026,00012-Ruiz,Kim Park,1,Work,No",
      "11/02/2026,00012-Ruiz,Lou Grant,1,Old work,No",
    ].join("\n");
    const { plan } = planImport("time_entries", csv, ctx({ matters: withMatters() }));
    expect(plan.rows[0]!.reason).toMatch(/no Docket account matches 'Nobody Here'/);
    expect(plan.rows[1]!.reason).toMatch(/receptionist account/);
    // A disabled former attorney's real time still imports, with a note.
    expect(plan.rows[2]).toMatchObject({ action: "create" });
    expect(plan.rows[2]!.warnings.join(" ")).toMatch(/disabled/);
  });

  it("rejects unknown matters, future dates, unreadable hours, a day-plus entry and a missing description", () => {
    const csv = [
      "Date,Matter,User,Hours,Description,Billed",
      "11/02/2026,99999-Nope,ada,1,Work,No",
      "12/25/2026,00012-Ruiz,ada,1,Work,No",
      "11/02/2026,00012-Ruiz,ada,some,Work,No",
      "11/02/2026,00012-Ruiz,ada,30,Work,No",
      "11/02/2026,00012-Ruiz,ada,1,,No",
      "11/02/2026,00012-Ruiz,ada,0,Nothing,No",
    ].join("\n");
    const { plan } = planImport("time_entries", csv, ctx({ matters: withMatters() }));
    expect(plan.rows.map((r) => r.action)).toEqual(["error", "error", "error", "error", "error", "skip"]);
    expect(plan.rows[0]!.reason).toMatch(/import the matters first/);
    expect(plan.rows[1]!.reason).toBe("dated in the future");
    expect(plan.rows[3]!.reason).toMatch(/more than a day/);
    expect(plan.rows[4]!.reason).toMatch(/no description/);
  });

  it("importing the same file twice adds nothing the second time, but genuine repeats in one file both import", () => {
    const store = withMatters();
    const csv = "Date,Matter,User,Hours,Description,Billed\n11/02/2026,00012-Ruiz,ada,0.1,Call,No\n11/02/2026,00012-Ruiz,ada,0.1,Call,No";
    const first = planImport("time_entries", csv, ctx({ matters: store }));
    expect(first.plan.counts.create).toBe(2);
    const hours = new BillingHoursStore();
    for (const e of first.timeEntries) hours.log(e);
    const second = planImport("time_entries", csv, ctx({ matters: store, billingEntries: hours.listAll() }));
    expect(second.plan.counts).toEqual({ create: 0, skip: 2, error: 0 });
  });

  it("calls out a name matching more than one matter", () => {
    const store = new MatterStore();
    store.upsert("a", { title: "Estate of Kay" });
    store.upsert("b", { title: "Estate of Kay" });
    const { plan } = planImport("time_entries", "Date,Matter,User,Hours,Description,Billed\n11/02/2026,Estate of Kay,ada,1,Work,No", ctx({ matters: store }));
    expect(plan.rows[0]!.reason).toMatch(/more than one matter/);
  });
});

describe("ImportService", () => {
  const attorney: Actor = { id: "att-ada", role: "attorney" };
  const paralegal: Actor = { id: "para-sam", role: "paralegal" };

  function setup() {
    const matters = new MatterStore();
    const billingHours = new BillingHoursStore();
    const auditLog = new AuditLog();
    const auth = new AuthService();
    auth.createUser({ username: "ada", password: "password123", role: "attorney", actorId: "att-ada", displayName: "Ada Brooks" });
    auth.createUser({ username: "sam", password: "password123", role: "paralegal", actorId: "para-sam", displayName: "Sam Ortiz" });
    const trust = new TrustLedger();
    const service = new ImportService({ matters, billingHours, auth, auditLog, trust, now: () => NOW });
    return { service, matters, billingHours, auditLog };
  }

  const MATTERS = "Matter Number,Matter Name,Client,Adverse Party,Open Date\nR-1,State v. Ruiz,Maria Ruiz,The State,2025-03-14\nR-2,Chen DUI,Wei Chen,,";

  it("is attorney-only, preview included", () => {
    const { service } = setup();
    expect(() => service.preview(paralegal, { kind: "matters", csv: MATTERS })).toThrow(AccessDeniedError);
    expect(() => service.commit(paralegal, { kind: "matters", csv: MATTERS, fingerprint: "x" })).toThrow(AccessDeniedError);
  });

  it("a preview writes nothing; a commit writes exactly what was previewed and audits it", () => {
    const { service, matters, auditLog } = setup();
    const plan = service.preview(attorney, { kind: "matters", csv: MATTERS, fileName: "clio-matters.csv" });
    expect(matters.listAll()).toHaveLength(0);
    expect(auditLog.read("attorney")).toHaveLength(0);

    const result = service.commit(attorney, { kind: "matters", csv: MATTERS, fingerprint: plan.fingerprint, fileName: "clio-matters.csv" });
    expect(result).toMatchObject({ kind: "matters", created: 2, skipped: 0, leftOut: 0, matterIds: ["R-1", "R-2"] });
    expect(matters.get("R-1")!.openedAt).toBe("2025-03-14T00:00:00.000Z");
    expect(matters.get("R-1")!.parties.map((p) => p.role)).toEqual(["client", "adverse"]);

    const actions = auditLog.read("attorney").map((e) => e.action);
    expect(actions).toEqual(["matter_imported", "matter_imported", "data_import_committed"]);
    const summary = auditLog.read("attorney").at(-1)!;
    expect(summary.detail).toMatch(/created=2/);
    expect(summary.detail).toMatch(/file=clio-matters\.csv/);
  });

  it("refuses a commit whose plan changed since the preview", () => {
    const { service, matters } = setup();
    const plan = service.preview(attorney, { kind: "matters", csv: MATTERS });
    matters.upsert("R-2", { title: "Someone made this meanwhile" });
    expect(() => service.commit(attorney, { kind: "matters", csv: MATTERS, fingerprint: plan.fingerprint })).toThrow(
      expect.objectContaining({ kind: "stale" }),
    );
    expect(matters.get("R-1")).toBeUndefined();
  });

  it("refuses a different column mapping than the one previewed", () => {
    const { service } = setup();
    const plan = service.preview(attorney, { kind: "matters", csv: MATTERS });
    expect(() =>
      service.commit(attorney, { kind: "matters", csv: MATTERS, fingerprint: plan.fingerprint, mapping: { adverseParty: "" } }),
    ).toThrow(expect.objectContaining({ kind: "stale" }));
  });

  it("needs conflicts acknowledged before committing", () => {
    const { service, matters } = setup();
    matters.upsert("old", { title: "Ruiz family", status: "open", parties: [{ name: "The State", role: "client", note: undefined, email: undefined, phone: undefined }] });
    const plan = service.preview(attorney, { kind: "matters", csv: MATTERS });
    expect(plan.needsConflictAcknowledgement).toBe(true);
    expect(() => service.commit(attorney, { kind: "matters", csv: MATTERS, fingerprint: plan.fingerprint })).toThrow(/acknowledgement/);
    const result = service.commit(attorney, { kind: "matters", csv: MATTERS, fingerprint: plan.fingerprint, acknowledgeConflicts: true });
    expect(result.created).toBe(2);
  });

  it("imports time entries and records a per-matter audit entry", () => {
    const { service, matters, billingHours, auditLog } = setup();
    matters.upsert("R-1", { title: "State v. Ruiz" });
    const csv = "Date,Matter,User,Hours,Description,Billed\n11/02/2026,R-1,ada,1.5,Prep,No\n11/03/2026,R-1,sam,0.5,Call,No\n11/03/2026,R-1,sam,0.5,Billed call,Yes";
    const plan = service.preview(attorney, { kind: "time_entries", csv });
    const result = service.commit(attorney, { kind: "time_entries", csv, fingerprint: plan.fingerprint });
    expect(result).toMatchObject({ created: 2, skipped: 1, hoursCreated: 2 });
    expect(billingHours.listByMatter("R-1").map((e) => [e.actorId, e.hours])).toEqual([
      ["att-ada", 1.5],
      ["para-sam", 0.5],
    ]);
    const entries = auditLog.read("attorney");
    expect(entries.find((e) => e.action === "billing_hours_imported")!.detail).toMatch(/entries=2 hours=2/);

    // Running it again finds nothing new.
    const again = service.preview(attorney, { kind: "time_entries", csv });
    expect(again.counts.create).toBe(0);
    expect(() => service.commit(attorney, { kind: "time_entries", csv, fingerprint: again.fingerprint })).toThrow(/nothing in this file/);
  });

  it("refuses an empty or oversized file", () => {
    const { service } = setup();
    expect(() => service.preview(attorney, { kind: "matters", csv: "  " })).toThrow(/choose a CSV file/);
    expect(() => service.preview(attorney, { kind: "matters", csv: "a\n" + "x".repeat(5 * 1024 * 1024) })).toThrow(/larger than 5 MB/);
  });
});

describe("import over HTTP", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function boot(withImport: boolean) {
    const auth = new AuthService();
    auth.createUser({ username: "ada", password: "password123", role: "attorney", actorId: "att-ada", displayName: "Ada Brooks" });
    auth.createUser({ username: "sam", password: "password123", role: "paralegal", actorId: "para-sam" });
    const matters = new MatterStore();
    let mutations = 0;
    const dataImport = new ImportService({ matters, billingHours: new BillingHoursStore(), auth, auditLog: new AuditLog(), now: () => NOW });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      ...(withImport ? { dataImport } : {}),
      onMutated: () => {
        mutations++;
      },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const login = async (username: string) =>
      (
        await fetch(`${baseUrl}/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: "password123" }),
        })
      ).headers
        .get("set-cookie")!
        .split(";")[0]!;
    const post = (path: string, cookie: string, body: unknown) =>
      fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    return { login, post, matters, mutations: () => mutations };
  }

  const csv = "Matter Number,Matter Name,Client\nH-1,Over HTTP,Pat Lee";

  it("404s when importing isn't configured", async () => {
    const { login, post } = await boot(false);
    expect((await post("/api/import/preview", await login("ada"), { kind: "matters", csv })).status).toBe(404);
  });

  it("previews without saving, commits with a save, and maps refusals to status codes", async () => {
    const { login, post, matters, mutations } = await boot(true);
    const ada = await login("ada");

    expect((await post("/api/import/preview", await login("sam"), { kind: "matters", csv })).status).toBe(403);
    expect((await post("/api/import/preview", ada, { kind: "nonsense", csv })).status).toBe(400);
    expect((await post("/api/import/preview", ada, { kind: "matters", csv: 'a,b\n"open' })).status).toBe(400);

    // Logging in saves (sessions persist), so count from here.
    const before = mutations();
    const preview = await post("/api/import/preview", ada, { kind: "matters", csv });
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect(plan.counts.create).toBe(1);
    expect(mutations()).toBe(before);

    expect((await post("/api/import/commit", ada, { kind: "matters", csv, fingerprint: "wrong" })).status).toBe(409);

    const commit = await post("/api/import/commit", ada, { kind: "matters", csv, fingerprint: plan.fingerprint, fileName: "m.csv" });
    expect(commit.status).toBe(200);
    expect((await commit.json()).created).toBe(1);
    expect(matters.get("H-1")!.title).toBe("Over HTTP");
    expect(mutations()).toBe(before + 1);
  });
});
