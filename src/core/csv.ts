/**
 * A small RFC 4180 CSV reader for the import tool (`data-import.ts`).
 *
 * Hand-rolled rather than pulled in as a dependency, same call as the
 * SMTP client and the TOTP code: the format is small and the cases that
 * matter are knowable. The ones exports from practice-management tools
 * actually produce, and that a naive `split(",")` gets wrong:
 *
 * - quoted values containing commas ("Smith, John"), doubled quotes, and
 *   line breaks (a multi-line matter description);
 * - CRLF, LF or bare CR line endings, and a UTF-8 byte-order mark;
 * - semicolon- or tab-separated files, which Excel writes in locales
 *   where the comma is the decimal separator.
 *
 * Every record remembers the physical line it started on, so an error
 * can say "line 214" and mean the line a spreadsheet shows.
 */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvRecord {
  /** The 1-based physical line this record starts on. */
  line: number;
  values: string[];
}

export interface ParsedCsv {
  headers: string[];
  records: CsvRecord[];
  delimiter: CsvDelimiter;
}

/** Counts each candidate delimiter outside quotes on the first line, and picks the most frequent. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t")) counts[ch]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

export function parseCsv(input: string, options: { maxRecords?: number } = {}): ParsedCsv {
  const maxRecords = options.maxRecords ?? 5000;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const rows: CsvRecord[] = [];
  let field = "";
  let values: string[] = [];
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let recordLine = 1;
  // Whether anything at all has been read into the current record, so a
  // trailing newline doesn't produce a phantom empty record.
  let started = false;

  const endRecord = () => {
    values.push(field);
    field = "";
    if (values.some((v) => v.trim() !== "")) {
      rows.push({ line: recordLine, values });
      // +1 for the header row, which isn't a record.
      if (rows.length > maxRecords + 1) {
        throw new CsvError(`this file has more than ${maxRecords} rows; split it into smaller files and import them one at a time`);
      }
    }
    values = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === "\r") {
        // A line break inside a quoted value is kept, but as a plain "\n"
        // whatever the file's line endings, so a Windows export doesn't
        // leave a stray carriage return at the end of a value's first line.
        if (text[i + 1] === "\n") i++;
        line++;
        field += "\n";
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (!started) {
      started = true;
      recordLine = line;
    }
    if (ch === '"' && field.trim() === "") {
      // A quote opens a quoted value only at the start of a field; one in
      // the middle of an unquoted value is kept literally, which is what
      // spreadsheet programs do.
      field = "";
      inQuotes = true;
      quoteStartLine = line;
    } else if (ch === delimiter) {
      values.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new CsvError(`a quoted value starting on line ${quoteStartLine} never ends — check for a stray quotation mark`);
  }
  if (started) endRecord();

  const [header, ...records] = rows;
  if (!header) throw new CsvError("this file is empty");
  const headers = header.values.map((h) => h.trim());
  return {
    headers,
    // Short rows are padded so a missing trailing value reads as blank
    // rather than undefined.
    records: records.map((r) => ({ line: r.line, values: headers.map((_, i) => (r.values[i] ?? "").trim()) })),
    delimiter,
  };
}
