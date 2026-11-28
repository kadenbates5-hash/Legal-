import { createHash } from "node:crypto";
import { parseCsv, type CsvDelimiter, type CsvRecord } from "./csv.js";
import { ConflictChecker, normalizeName, type ConflictSeverity, type MatchStrength } from "./conflicts.js";
import { addYears, MatterStore, type MatterInput, type MatterParty, type MatterStatus } from "./matters.js";
import type { BillingHoursEntry } from "./billing-hours.js";
import { addDaysToCalendarDate, todayIn } from "./calendar-date.js";

/**
 * Bringing a firm's records over from the practice-management tool it
 * used before (Clio, MyCase, PracticePanther, or a spreadsheet), as CSV.
 *
 * Nobody switches systems by retyping two hundred matters, and a firm
 * that can't get its history in tends not to switch at all — or switches
 * and keeps the old system running "for reference", which is how records
 * end up in two places disagreeing. So this exists. But an import is also
 * the fastest way to put a lot of wrong data into a system at once, so
 * the design is mostly about what it refuses to do quietly:
 *
 * - **Nothing is written until an attorney has seen exactly what will
 *   be.** `planImport()` is pure: it reads the file and the current
 *   records and says, row by row, what it would create, what it would
 *   skip and why, and what it can't make sense of. The commit re-plans
 *   from the same file and refuses if the result differs at all from the
 *   preview (`fingerprint`), so what was approved is what lands.
 * - **Existing records are never overwritten or merged.** A matter number
 *   already in Docket is skipped and left alone. Party lists are the
 *   input to every future conflicts check, and an import silently
 *   rewriting them would be a way to weaken screening nobody could see.
 * - **Time already billed in the old system is not imported**, because
 *   imported hours can be added to a new invoice here, and billing a
 *   client twice for the same work is a fee violation. A file that
 *   doesn't say which entries were billed gets a warning saying so.
 *   Importing the same file twice doesn't double anything either.
 * - **Imported matters are conflict-screened** against every existing
 *   record and against each other. A hit doesn't stop the import — these
 *   are engagements that already exist, and refusing to record one would
 *   hide the conflict rather than remove it — but the attorney has to
 *   acknowledge the hits before committing.
 * - **Time is attributed to real accounts only.** A timekeeper with no
 *   matching attorney/paralegal account is an error, not "the person
 *   importing", since who did the work is what an itemised bill states.
 *
 * Column names differ between tools, so each field has a list of header
 * aliases and the attorney can override any guess. The aliases are
 * written from these tools' documented export layouts and common
 * spreadsheet conventions; they are best guesses, which is why the
 * preview shows which column each field was read from.
 */
export type ImportKind = "matters" | "time_entries";

export class DataImportError extends Error {
  constructor(
    message: string,
    /** `invalid`: a malformed request (400). `stale`: the records changed since the preview (409). */
    readonly kind: "invalid" | "stale",
  ) {
    super(message);
    this.name = "DataImportError";
  }
}

interface FieldSpec {
  field: string;
  label: string;
  required: boolean;
  /** Normalized header names (lowercase, letters and digits only), most specific first. */
  aliases: string[];
}

export const MATTER_IMPORT_FIELDS: readonly FieldSpec[] = [
  { field: "matterId", label: "Matter number", required: false, aliases: ["matterid", "matternumber", "matterno", "displaynumber", "matterdisplaynumber", "filenumber", "fileno", "caseid", "clientmatternumber", "referencenumber", "reference"] },
  { field: "title", label: "Matter name", required: false, aliases: ["title", "mattername", "mattertitle", "casename", "matter", "name", "case"] },
  { field: "client", label: "Client", required: false, aliases: ["client", "clientname", "clients", "primaryclient", "clientcontact", "contact", "contactname", "contacts", "account", "accountname"] },
  { field: "clientEmail", label: "Client email", required: false, aliases: ["clientemail", "clientemailaddress", "contactemail", "email", "emailaddress", "primaryemail"] },
  { field: "clientPhone", label: "Client phone", required: false, aliases: ["clientphone", "clientphonenumber", "contactphone", "phone", "phonenumber", "mobile", "mobilephone", "cellphone", "primaryphone"] },
  { field: "adverseParty", label: "Adverse party", required: false, aliases: ["adverseparty", "adverseparties", "opposingparty", "opposingparties", "otherparty", "otherparties", "adverse", "opponent"] },
  { field: "status", label: "Status", required: false, aliases: ["status", "matterstatus", "casestatus"] },
  { field: "responsibleAttorney", label: "Responsible attorney", required: false, aliases: ["responsibleattorney", "leadattorney", "responsiblelawyer", "assignedattorney", "attorney", "lawyer", "assignedto", "originatingattorney"] },
  { field: "practiceArea", label: "Practice area", required: false, aliases: ["practicearea", "practicetype", "mattertype", "casetype", "area"] },
  { field: "court", label: "Court", required: false, aliases: ["court", "courtname", "venue", "jurisdiction"] },
  { field: "caseNumber", label: "Court case number", required: false, aliases: ["casenumber", "courtcasenumber", "docketnumber", "docket", "causenumber", "indexnumber"] },
  { field: "opposingCounsel", label: "Opposing counsel", required: false, aliases: ["opposingcounsel", "opposingattorney", "adversecounsel", "opposinglawyer"] },
  { field: "description", label: "Description", required: false, aliases: ["description", "matterdescription", "casedescription", "notes", "note", "summary"] },
  { field: "openedOn", label: "Opened", required: false, aliases: ["opendate", "dateopened", "openedon", "opened", "openeddate", "startdate", "createddate", "created", "datecreated"] },
  { field: "closedOn", label: "Closed", required: false, aliases: ["closedate", "dateclosed", "closedon", "closed", "closeddate", "enddate"] },
];

export const TIME_IMPORT_FIELDS: readonly FieldSpec[] = [
  { field: "date", label: "Date", required: true, aliases: ["date", "entrydate", "activitydate", "workdate", "dateofservice", "servicedate", "day"] },
  { field: "matter", label: "Matter", required: true, aliases: ["matter", "matternumber", "matterid", "displaynumber", "matterdisplaynumber", "mattername", "case", "casename", "casenumber", "file"] },
  { field: "timekeeper", label: "Timekeeper", required: true, aliases: ["timekeeper", "user", "username", "staff", "staffmember", "billedby", "attorney", "employee", "firmuser", "person", "name"] },
  { field: "hours", label: "Hours", required: true, aliases: ["hours", "quantity", "duration", "billablehours", "totalhours", "hrs", "qty", "time"] },
  { field: "description", label: "Description", required: true, aliases: ["description", "note", "notes", "narrative", "activitydescription", "details", "entrydescription", "task", "activity"] },
  { field: "billed", label: "Already billed?", required: false, aliases: ["billed", "billedstatus", "billingstatus", "billstatus", "invoicestatus", "status", "invoiced", "invoicenumber", "invoice", "billnumber"] },
  { field: "billable", label: "Billable?", required: false, aliases: ["billable", "isbillable", "nonbillable"] },
  { field: "type", label: "Entry type", required: false, aliases: ["type", "entrytype", "activitytype", "kind"] },
];

export function fieldsFor(kind: ImportKind): readonly FieldSpec[] {
  return kind === "matters" ? MATTER_IMPORT_FIELDS : TIME_IMPORT_FIELDS;
}

export function normalizeHeader(header: string): string {
  return header.normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Which column each field is read from. An override names a header
 * exactly as it appears in the file, or "" for "this file doesn't have
 * it"; everything not overridden is guessed from the aliases, most
 * specific alias first, each column used for at most one field.
 */
export function detectColumns(
  headers: readonly string[],
  kind: ImportKind,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, number | undefined> {
  const fields = fieldsFor(kind);
  const result: Record<string, number | undefined> = {};
  const claimed = new Set<number>();

  for (const spec of fields) {
    if (!(spec.field in overrides)) continue;
    const wanted = overrides[spec.field]!;
    if (wanted === "") {
      result[spec.field] = undefined;
      continue;
    }
    const index = headers.findIndex((h, i) => h === wanted && !claimed.has(i));
    if (index < 0) throw new DataImportError(`there's no column called '${wanted}' in this file`, "invalid");
    result[spec.field] = index;
    claimed.add(index);
  }

  const normalized = headers.map(normalizeHeader);
  for (const spec of fields) {
    if (spec.field in overrides) continue;
    let found: number | undefined;
    for (const alias of spec.aliases) {
      const index = normalized.findIndex((h, i) => h === alias && !claimed.has(i));
      if (index >= 0) {
        found = index;
        break;
      }
    }
    result[spec.field] = found;
    if (found !== undefined) claimed.add(found);
  }
  return result;
}

/** A cosmetic guess at where the file came from, from its column names. Never used to decide anything. */
export function guessSource(headers: readonly string[]): string | undefined {
  const h = new Set(headers.map(normalizeHeader));
  if (h.has("displaynumber") || h.has("originatingattorney") || (h.has("quantity") && h.has("matter"))) return "Clio";
  if (h.has("casename") || h.has("leadattorney") || h.has("casestage")) return "MyCase";
  if (h.has("billedby") || (h.has("account") && (h.has("mattername") || h.has("matter")))) return "PracticePanther";
  return undefined;
}

// ---------------------------------------------------------------------------
// Value parsing

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string | undefined {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return undefined;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > daysInMonth) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Dates as these tools and spreadsheets write them: `2026-07-28` (with or
 * without a time after it), US `7/28/2026` or `07/28/26`, `28-Jul-2026`,
 * `Jul 28, 2026` and `July 28 2026`. Slashed dates are read month-first,
 * as US tools write them; a day over 12 in the first position is read
 * day-first rather than rejected, since it can only mean one thing.
 */
export function parseImportDate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(value);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(value);
  if (m) {
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year >= 70 ? 1900 : 2000;
    const first = Number(m[1]);
    const second = Number(m[2]);
    return first > 12 ? isoDate(year, second, first) : isoDate(year, first, second);
  }
  m = /^(\d{1,2})[\s-]([a-z]{3,9})\.?[\s-](\d{4})$/i.exec(value);
  if (m) {
    const month = MONTHS[m[2]!.slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    return month ? isoDate(Number(m[3]), month, Number(m[1])) : undefined;
  }
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(value);
  if (m) {
    const month = MONTHS[m[1]!.slice(0, m[1]!.toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()];
    return month ? isoDate(Number(m[3]), month, Number(m[2])) : undefined;
  }
  return undefined;
}

/**
 * Durations as exported: decimal hours (`1.5`, `1,5` from a comma-decimal
 * locale), `1:30`, `1h 30m`, `90m`/`90 min`. Returns hours, rounded to
 * the hundredth.
 */
export function parseImportHours(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  let hours: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+):([0-5]\d)(?::[0-5]\d)?$/.exec(value))) {
    hours = Number(m[1]) + Number(m[2]) / 60;
  } else if ((m = /^(?:(\d+(?:[.,]\d+)?)\s*h(?:rs?|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(value)) && (m[1] || m[2])) {
    hours = Number((m[1] ?? "0").replace(",", ".")) + Number(m[2] ?? 0) / 60;
  } else if (/^\d+(?:[.,]\d+)?$/.test(value)) {
    hours = Number(value.replace(",", "."));
  }
  if (hours === undefined || !Number.isFinite(hours)) return undefined;
  return Math.round(hours * 100) / 100;
}

const YES_RE = /^(?:y|yes|true|1|x|✓|billed|invoiced|paid|partially paid|partial|sent|closed)$/i;
const NO_RE = /^(?:n|no|false|0|unbilled|not billed|draft|open|pending|wip|work in progress|unpaid|ready to bill|)$/i;

function parseYesNo(raw: string): boolean | undefined {
  const value = raw.trim();
  if (YES_RE.test(value)) return true;
  if (NO_RE.test(value)) return false;
  return undefined;
}

function parseMatterStatus(raw: string): { status: MatterStatus; recognised: boolean } {
  const value = raw.trim().toLowerCase();
  if (!value) return { status: "open", recognised: true };
  if (/^(?:closed?|inactive|archived?|completed?|resolved|done|dismissed|disposed)$/.test(value)) return { status: "closed", recognised: true };
  if (/^(?:prospective|pending|lead|potential|intake|consult(?:ation)?|new lead|pre-?retention|not retained)$/.test(value)) return { status: "prospective", recognised: true };
  if (/^(?:open(?:ed)?|active|current|in progress|ongoing|retained)$/.test(value)) return { status: "open", recognised: true };
  return { status: "open", recognised: false };
}

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value: string | undefined, max: number, label: string, warnings: string[]): string | undefined {
  const text = (value ?? "").replace(CONTROL_CHARS_RE, "").trim();
  if (!text) return undefined;
  if (text.length > max) {
    warnings.push(`${label} was longer than ${max} characters and has been cut short`);
    return text.slice(0, max);
  }
  return text;
}

/** Titles, court names, case numbers and invoice lines are one line each, whatever the cell held. */
function oneLine(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(/\s+/g, " ").trim();
}

/** Splits a cell that may name several people. Only on `;` and line breaks — "Smith, John" is one person. */
function splitNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[;\n]/)
    .map((n) => n.replace(CONTROL_CHARS_RE, "").trim())
    .filter(Boolean);
}

function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Characters a matter id can't carry: it travels in URL paths, and `<`/`>` mean something in the party editor. */
const BAD_ID_CHARS_RE = /[/\\?#%<>"`]/;
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[a-z]{2,}$/i;

function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return undefined;
}

function sameName(a: string, b: string): boolean {
  const left = normalizeName(a).tokens.slice().sort().join(" ");
  const right = normalizeName(b).tokens.slice().sort().join(" ");
  return left !== "" && left === right;
}

// ---------------------------------------------------------------------------
// The plan

export interface ImportPerson {
  actorId: string;
  username: string;
  displayName: string;
  role: string;
  disabled: boolean;
}

export interface ImportContext {
  matters: MatterStore;
  people: readonly ImportPerson[];
  billingEntries: readonly BillingHoursEntry[];
  /** Client funds held for a matter id; a matter can't be imported as closed while any remain. */
  trustBalanceCents?: (matterId: string) => number;
  /** Matter ids other stores (work product, documents, time) already use without a matter record. */
  matterIdsInUse?: ReadonlySet<string>;
  retentionYears?: number;
  now: Date;
  /** The firm's zone, for "today" (a missing close date, a date in the future). Absent, UTC. */
  timeZone?: string;
}

export interface PlannedConflict {
  searchedName: string;
  matterId: string;
  matterTitle: string;
  severity: ConflictSeverity;
  matchStrength: MatchStrength;
  explanation: string;
}

export interface PlannedRow {
  /** The line in the file, as a spreadsheet numbers it. */
  line: number;
  action: "create" | "skip" | "error";
  /** Why a row is skipped or can't be imported. */
  reason?: string;
  warnings: string[];
  summary: string;
  matterId?: string;
  conflicts?: PlannedConflict[];
}

export interface ImportPlan {
  kind: ImportKind;
  sourceGuess: string | undefined;
  delimiter: CsvDelimiter;
  headers: string[];
  columns: Array<{ field: string; label: string; required: boolean; header: string | undefined }>;
  /** Required fields the file has no column for — nothing can be imported until they're chosen. */
  missingRequired: string[];
  unusedHeaders: string[];
  notes: string[];
  rows: PlannedRow[];
  counts: { create: number; skip: number; error: number };
  /** Hours across the time entries that would be created. */
  hoursToCreate?: number;
  needsConflictAcknowledgement: boolean;
  fingerprint: string;
}

export interface MatterImportPayload {
  matterId: string;
  input: MatterInput;
  openedAt: string | undefined;
  closedAt: string | undefined;
}

export interface TimeImportPayload {
  matterId: string;
  actorId: string;
  date: string;
  hours: number;
  description: string;
}

export interface PlannedImport {
  plan: ImportPlan;
  matters: MatterImportPayload[];
  timeEntries: TimeImportPayload[];
}

function cell(record: CsvRecord, columns: Record<string, number | undefined>, field: string): string {
  const index = columns[field];
  return index === undefined ? "" : (record.values[index] ?? "").trim();
}

export function planImport(
  kind: ImportKind,
  csv: string,
  ctx: ImportContext,
  options: { mapping?: Readonly<Record<string, string>>; maxRows?: number } = {},
): PlannedImport {
  if (kind !== "matters" && kind !== "time_entries") {
    throw new DataImportError("choose what the file contains: matters, or time entries", "invalid");
  }
  const parsed = parseCsv(csv, { maxRecords: options.maxRows ?? 5000 });
  const columns = detectColumns(parsed.headers, kind, options.mapping ?? {});
  const specs = fieldsFor(kind);
  const used = new Set(Object.values(columns).filter((i): i is number => i !== undefined));

  const missingRequired = specs.filter((s) => s.required && columns[s.field] === undefined).map((s) => s.label);
  if (kind === "matters" && columns["matterId"] === undefined && columns["title"] === undefined) {
    missingRequired.push("Matter number or Matter name");
  }

  const base = {
    kind,
    sourceGuess: guessSource(parsed.headers),
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    columns: specs.map((s) => ({
      field: s.field,
      label: s.label,
      required: s.required,
      header: columns[s.field] === undefined ? undefined : parsed.headers[columns[s.field]!],
    })),
    missingRequired,
    unusedHeaders: parsed.headers.filter((h, i) => !used.has(i) && h !== ""),
  };

  if (parsed.records.length === 0) {
    throw new DataImportError("this file has a header row but no records under it", "invalid");
  }

  const result =
    missingRequired.length > 0
      ? { rows: [] as PlannedRow[], notes: [] as string[], matters: [], timeEntries: [], needsAck: false, hours: undefined }
      : kind === "matters"
        ? planMatters(parsed.records, columns, ctx, base.sourceGuess)
        : planTimeEntries(parsed.records, columns, ctx, parsed.headers);

  const counts = { create: 0, skip: 0, error: 0 };
  for (const row of result.rows) counts[row.action]++;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ kind, columns, rows: result.rows.map((r) => [r.line, r.action, r.reason ?? ""]), matters: result.matters, timeEntries: result.timeEntries }))
    .digest("hex");

  return {
    plan: {
      ...base,
      notes: result.notes,
      rows: result.rows,
      counts,
      ...(result.hours !== undefined ? { hoursToCreate: result.hours } : {}),
      needsConflictAcknowledgement: result.needsAck,
      fingerprint,
    },
    matters: result.matters,
    timeEntries: result.timeEntries,
  };
}

function planMatters(
  records: readonly CsvRecord[],
  columns: Record<string, number | undefined>,
  ctx: ImportContext,
  sourceGuess: string | undefined,
): { rows: PlannedRow[]; notes: string[]; matters: MatterImportPayload[]; timeEntries: []; needsAck: boolean; hours: undefined } {
  const rows: PlannedRow[] = [];
  const payloads: MatterImportPayload[] = [];
  const notes: string[] = [];
  const seen = new Map<string, number>();
  const attorneys = ctx.people.filter((p) => p.role === "attorney");
  const today = todayIn(ctx.timeZone, ctx.now);

  if (columns["matterId"] === undefined) {
    notes.push("This file has no matter-number column, so each matter's id is made from its name. Importing the same file again matches on those names.");
  }
  if (columns["client"] === undefined) {
    notes.push("No client column was found. Matters without a client can't be screened for conflicts until one is added.");
  }
  if (columns["adverseParty"] === undefined) {
    notes.push("No adverse-party column was found. Adverse parties drive conflicts screening — add them to each matter after importing, or choose the column below.");
  }

  for (const record of records) {
    const warnings: string[] = [];
    const fail = (reason: string, summary: string, matterId?: string) =>
      rows.push({ line: record.line, action: "error", reason, warnings, summary, ...(matterId ? { matterId } : {}) });

    const rawId = cell(record, columns, "matterId").replace(CONTROL_CHARS_RE, "");
    const description = clean(cell(record, columns, "description"), 4000, "The description", warnings);
    const title =
      oneLine(clean(cell(record, columns, "title"), 200, "The matter name", warnings)) ??
      (description ? description.split("\n")[0]!.slice(0, 120) : undefined) ??
      (rawId || undefined);

    let matterId = rawId;
    const derived = !matterId;
    if (derived) {
      if (!title) {
        fail("no matter number or name", "(blank)");
        continue;
      }
      matterId = slug(title) || "";
      if (!matterId) {
        fail("couldn't make a matter id from this name — add a matter-number column", title);
        continue;
      }
    }
    if (matterId.length > 80) {
      fail("the matter number is longer than 80 characters", title ?? matterId.slice(0, 40));
      continue;
    }
    if (BAD_ID_CHARS_RE.test(matterId)) {
      fail("the matter number contains a character Docket can't use in an id (/ \\ ? # % < > \" `)", title ?? matterId);
      continue;
    }

    const summary = title && title !== matterId ? `${matterId} · ${title}` : matterId;
    const earlier = seen.get(matterId.toLowerCase());
    if (earlier !== undefined) {
      fail(`same matter ${derived ? "name" : "number"} as line ${earlier}`, summary, matterId);
      continue;
    }
    seen.set(matterId.toLowerCase(), record.line);

    const existing = ctx.matters.get(matterId);
    if (existing) {
      if (derived && !sameName(existing.title, title ?? "")) {
        fail(`the id made from this name ('${matterId}') already belongs to '${existing.title}' — add a matter-number column`, summary, matterId);
      } else {
        rows.push({ line: record.line, action: "skip", reason: "already in Docket — left unchanged", warnings, summary, matterId });
      }
      continue;
    }

    const { status, recognised } = parseMatterStatus(cell(record, columns, "status"));
    if (!recognised) warnings.push(`status '${cell(record, columns, "status")}' isn't one Docket knows, so it's imported as open`);

    const parties: MatterParty[] = [];
    const scrub = (name: string) => {
      if (/[<>[\]]/.test(name)) {
        warnings.push(`removed < > [ ] from '${name}' — the party editor uses them for contact details`);
        return name.replace(/[<>[\]]/g, "").trim();
      }
      return name;
    };
    const clients = splitNames(cell(record, columns, "client")).map(scrub).filter(Boolean);
    const adverse = splitNames(cell(record, columns, "adverseParty")).map(scrub).filter(Boolean);
    const tooLong = [...clients, ...adverse].find((n) => n.length > 200);
    if (tooLong) {
      fail(`a party name is longer than 200 characters ('${tooLong.slice(0, 40)}…') — is the column right?`, summary, matterId);
      continue;
    }

    const emailRaw = cell(record, columns, "clientEmail");
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : undefined;
    if (emailRaw && !email) warnings.push(`'${emailRaw}' doesn't look like an email address, so it wasn't imported`);
    const phoneRaw = cell(record, columns, "clientPhone");
    const phone = phoneRaw ? normalizePhone(phoneRaw) : undefined;
    if (phoneRaw && !phone) warnings.push(`'${phoneRaw}' couldn't be read as a phone number, so it wasn't imported`);
    if ((email || phone) && clients.length === 0) warnings.push("contact details were given but no client to attach them to");

    clients.forEach((name, i) =>
      parties.push({ name, role: "client", note: undefined, email: i === 0 ? email : undefined, phone: i === 0 ? phone : undefined }),
    );
    for (const name of adverse) parties.push({ name, role: "adverse", note: undefined, email: undefined, phone: undefined });
    if (clients.length === 0) warnings.push("no client named — conflicts can't screen this matter until one is added");

    const attorneyName = cell(record, columns, "responsibleAttorney");
    let responsibleAttorneyId: string | undefined;
    if (attorneyName) {
      const match = attorneys.filter((p) => p.username.toLowerCase() === attorneyName.toLowerCase() || sameName(p.displayName, attorneyName));
      if (match.length === 1) responsibleAttorneyId = match[0]!.actorId;
      else warnings.push(`no attorney account matches '${attorneyName}', so the matter is left unassigned`);
    }

    const practiceRaw = cell(record, columns, "practiceArea");
    const practiceAreaId = practiceRaw ? (/criminal/i.test(practiceRaw) ? "criminal-law" : slug(practiceRaw) || undefined) : undefined;

    const openedRaw = cell(record, columns, "openedOn");
    const openedOn = openedRaw ? parseImportDate(openedRaw) : undefined;
    if (openedRaw && !openedOn) warnings.push(`couldn't read the opened date '${openedRaw}', so today's date is used`);
    const closedRaw = cell(record, columns, "closedOn");
    let closedOn = closedRaw ? parseImportDate(closedRaw) : undefined;
    if (closedRaw && !closedOn) warnings.push(`couldn't read the closed date '${closedRaw}'`);
    if (closedOn && status !== "closed") {
      warnings.push("has a closed date but isn't marked closed, so it's imported as " + status);
      closedOn = undefined;
    }
    if (openedOn && openedOn > today) warnings.push("the opened date is in the future");

    if (status === "closed") {
      const held = ctx.trustBalanceCents?.(matterId) ?? 0;
      if (held > 0) {
        fail("Docket's trust ledger still holds client funds under this matter id, and a matter holding client funds can't be closed — refund or apply them first", summary, matterId);
        continue;
      }
      if (!closedOn) warnings.push("closed, but the file gives no close date, so today's date is recorded");
    }
    if (ctx.matterIdsInUse?.has(matterId)) {
      warnings.push("Docket already has work filed under this matter id; this record will describe it");
    }

    const closedAtIso = status === "closed" ? `${closedOn ?? today}T00:00:00.000Z` : undefined;
    const input: MatterInput = {
      title: title ?? matterId,
      status,
      parties,
      ...(practiceAreaId ? { practiceAreaId } : {}),
      ...(responsibleAttorneyId ? { responsibleAttorneyId } : {}),
      ...(description ? { description } : {}),
    };
    const court = oneLine(clean(cell(record, columns, "court"), 200, "The court", warnings));
    const caseNumber = oneLine(clean(cell(record, columns, "caseNumber"), 100, "The court case number", warnings));
    const opposingCounsel = oneLine(clean(cell(record, columns, "opposingCounsel"), 300, "Opposing counsel", warnings));
    if (court) input.court = court;
    if (caseNumber) input.caseNumber = caseNumber;
    if (opposingCounsel) input.opposingCounsel = opposingCounsel;
    if (status === "closed") {
      input.closingNote = `Imported as closed from ${sourceGuess ? `a ${sourceGuess} export` : "a CSV file"}.`;
      if (ctx.retentionYears && ctx.retentionYears > 0) input.retentionUntil = addYears(closedAtIso!.slice(0, 10), ctx.retentionYears);
    }

    rows.push({ line: record.line, action: "create", warnings, summary, matterId });
    payloads.push({
      matterId,
      input,
      openedAt: openedOn ? `${openedOn}T00:00:00.000Z` : undefined,
      closedAt: closedAtIso,
    });
  }

  // Screen every new matter against everything already on file *and*
  // against the rest of the file, by building the post-import world in
  // a scratch store. Rule 1.10 makes the whole firm's book the scope.
  const scratch = MatterStore.fromSnapshot(ctx.matters.toSnapshot());
  for (const p of payloads) scratch.upsert(p.matterId, p.input);
  const checker = new ConflictChecker(scratch);
  let needsAck = false;
  const byId = new Map(payloads.map((p) => [p.matterId, p]));
  for (const row of rows) {
    if (row.action !== "create" || !row.matterId) continue;
    const payload = byId.get(row.matterId)!;
    const names = (payload.input.parties ?? []).map((p) => p.name);
    if (names.length === 0) continue;
    const roleByName = Object.fromEntries((payload.input.parties ?? []).map((p) => [p.name, p.role]));
    const result = checker.check({ names, roleByName, excludeMatterId: row.matterId });
    if (result.hits.length === 0) continue;
    row.conflicts = result.hits.slice(0, 8).map((h) => ({
      searchedName: h.searchedName,
      matterId: h.matterId,
      matterTitle: h.matterTitle,
      severity: h.severity,
      matchStrength: h.matchStrength,
      explanation: h.explanation,
    }));
    if (result.requiresAttorneyReview) needsAck = true;
  }

  return { rows, notes, matters: payloads, timeEntries: [], needsAck, hours: undefined };
}

function planTimeEntries(
  records: readonly CsvRecord[],
  columns: Record<string, number | undefined>,
  ctx: ImportContext,
  headers: readonly string[],
): { rows: PlannedRow[]; notes: string[]; matters: []; timeEntries: TimeImportPayload[]; needsAck: boolean; hours: number } {
  const rows: PlannedRow[] = [];
  const payloads: TimeImportPayload[] = [];
  const notes: string[] = [];
  const timekeepers = ctx.people;
  const matters = ctx.matters.listAll();
  const tomorrow = addDaysToCalendarDate(todayIn(ctx.timeZone, ctx.now), 1);

  const billedHeader = columns["billed"] === undefined ? undefined : normalizeHeader(headers[columns["billed"]!]!);
  const billedIsInvoiceNumber = billedHeader !== undefined && /^(?:invoicenumber|invoice|billnumber)$/.test(billedHeader);
  const billableInverted = columns["billable"] !== undefined && normalizeHeader(headers[columns["billable"]!]!) === "nonbillable";

  if (columns["billed"] === undefined) {
    notes.push(
      "This file doesn't say which entries were already billed. Anything imported can be added to a new invoice here, so remove entries the old system already billed before importing — or choose the column that records it below.",
    );
  }
  if (headers.some((h) => /^(?:rate|billingrate|hourlyrate|amount|total|value|totalamount)$/.test(normalizeHeader(h)))) {
    notes.push("Rates and amounts in the file aren't imported. You set the rate when adding logged time to an invoice.");
  }

  // How many identical entries already exist, so importing a file twice
  // adds nothing the second time — while two genuinely identical entries
  // in one file (two 0.1-hour calls the same day) both still import.
  const keyOf = (e: { matterId: string; actorId: string; date: string; hours: number; description: string }) =>
    `${e.matterId}|${e.actorId}|${e.date}|${e.hours.toFixed(2)}|${e.description.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const existingCount = new Map<string, number>();
  for (const e of ctx.billingEntries) existingCount.set(keyOf(e), (existingCount.get(keyOf(e)) ?? 0) + 1);
  const fileCount = new Map<string, number>();

  const resolveMatter = (raw: string): { id?: string; error?: string } => {
    const value = raw.trim();
    const lower = value.toLowerCase();
    const exact = matters.find((m) => m.matterId === value) ?? matters.find((m) => m.matterId.toLowerCase() === lower);
    if (exact) return { id: exact.matterId };
    const byTitle = matters.filter((m) => m.title.toLowerCase() === lower);
    if (byTitle.length === 1) return { id: byTitle[0]!.matterId };
    if (byTitle.length > 1) return { error: `'${value}' matches more than one matter's name — use the matter number` };
    // Clio and others write a matter as "00012-Smith v. Jones" or "00012 - Smith".
    const prefixed = matters.filter((m) => {
      const id = m.matterId.toLowerCase();
      return lower.startsWith(id) && /^\s*[-–:·|]\s*|^\s+/.test(lower.slice(id.length)) && lower.length > id.length;
    });
    if (prefixed.length === 1) return { id: prefixed[0]!.matterId };
    if (prefixed.length > 1) {
      const longest = prefixed.sort((a, b) => b.matterId.length - a.matterId.length);
      if (longest[0]!.matterId.length > longest[1]!.matterId.length) return { id: longest[0]!.matterId };
      return { error: `'${value}' could be more than one matter — use the matter number` };
    }
    return { error: `no matter in Docket matches '${value}' — import the matters first` };
  };

  for (const record of records) {
    const warnings: string[] = [];
    const matterRaw = cell(record, columns, "matter");
    const who = cell(record, columns, "timekeeper");
    const hoursRaw = cell(record, columns, "hours");
    const dateRaw = cell(record, columns, "date");
    const readableHours = parseImportHours(hoursRaw);
    const summary =
      [dateRaw, matterRaw, who, readableHours !== undefined ? `${readableHours}h` : hoursRaw].filter(Boolean).join(" · ") || "(blank)";
    const skip = (reason: string) => rows.push({ line: record.line, action: "skip", reason, warnings, summary });
    const fail = (reason: string) => rows.push({ line: record.line, action: "error", reason, warnings, summary });

    const type = cell(record, columns, "type");
    if (type && /expense|cost|disbursement|flat\s*fee|fixed\s*fee|product/i.test(type)) {
      skip(`'${type}' is an expense or fixed fee, not time — add it to an invoice directly`);
      continue;
    }
    const billableRaw = cell(record, columns, "billable");
    if (billableRaw) {
      const flag = parseYesNo(billableRaw);
      const billable = flag === undefined ? undefined : billableInverted ? !flag : flag;
      if (billable === false) {
        skip("marked non-billable");
        continue;
      }
      if (billable === undefined) warnings.push(`couldn't tell whether '${billableRaw}' means billable; treated as billable`);
    }
    if (columns["billed"] !== undefined) {
      const billedRaw = cell(record, columns, "billed");
      const billed = billedIsInvoiceNumber ? billedRaw !== "" : parseYesNo(billedRaw);
      if (billed === undefined) {
        fail(`can't tell whether this entry was already billed ('${billedRaw}') — fix the value or choose another column`);
        continue;
      }
      if (billed) {
        skip("already billed in the old system — importing it would let it be billed again");
        continue;
      }
    }

    const date = parseImportDate(dateRaw);
    if (!date) {
      fail(dateRaw ? `couldn't read the date '${dateRaw}'` : "no date");
      continue;
    }
    if (date > tomorrow) {
      fail("dated in the future");
      continue;
    }
    if (!matterRaw) {
      fail("no matter");
      continue;
    }
    const matter = resolveMatter(matterRaw);
    if (!matter.id) {
      fail(matter.error!);
      continue;
    }
    if (!who) {
      fail("no timekeeper");
      continue;
    }
    const people = timekeepers.filter((p) => p.username.toLowerCase() === who.toLowerCase() || sameName(p.displayName, who));
    if (people.length > 1) {
      fail(`more than one account matches '${who}' — use the username`);
      continue;
    }
    const person = people[0];
    if (!person) {
      fail(`no Docket account matches '${who}'. Add one (it can be disabled straight afterwards) so the time is credited to the right person`);
      continue;
    }
    if (person.role !== "attorney" && person.role !== "paralegal") {
      fail(`'${who}' is a ${person.role} account — billable time is logged by attorneys and paralegals`);
      continue;
    }
    if (person.disabled) warnings.push(`${person.displayName}'s account is disabled`);

    const hours = parseImportHours(hoursRaw);
    if (hours === undefined) {
      fail(hoursRaw ? `couldn't read '${hoursRaw}' as hours` : "no hours");
      continue;
    }
    if (hours <= 0) {
      skip("zero hours");
      continue;
    }
    if (hours > 24) {
      fail(`${hours} hours in one entry — more than a day`);
      continue;
    }
    const description = oneLine(clean(cell(record, columns, "description"), 2000, "The description", warnings));
    if (!description) {
      fail("no description — an itemised bill has to say what the work was");
      continue;
    }

    const payload: TimeImportPayload = { matterId: matter.id, actorId: person.actorId, date, hours, description };
    const key = keyOf(payload);
    const n = (fileCount.get(key) ?? 0) + 1;
    fileCount.set(key, n);
    if (n <= (existingCount.get(key) ?? 0)) {
      rows.push({ line: record.line, action: "skip", reason: "already in Docket", warnings, summary, matterId: matter.id });
      continue;
    }
    rows.push({ line: record.line, action: "create", warnings, summary: `${date} · ${matter.id} · ${person.displayName} · ${hours}h`, matterId: matter.id });
    payloads.push(payload);
  }

  const hours = Math.round(payloads.reduce((sum, p) => sum + p.hours, 0) * 100) / 100;
  return { rows, notes, matters: [], timeEntries: payloads, needsAck: false, hours };
}
