import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceLineItem } from "../core/invoicing.js";
import { formatCents, formatQuantity, type RenderInvoiceParams } from "../core/invoice-render.js";

/**
 * The invoice as a PDF — the form a client can file, print, or forward to
 * their accountant, and the form most people mean by "the invoice".
 *
 * Behind a vendor-agnostic interface, same pattern as `PdfCondenser` and
 * `PdfTextExtractor` next door, over the `pdf-lib` this project already
 * depends on for condensing.
 *
 * It is laid out here rather than converted from `invoice-render.ts`'s
 * HTML, because there is no HTML-to-PDF path in this codebase that
 * wouldn't mean shipping a headless browser. The two renderers share
 * their *data* and their formatting helpers (`formatCents`,
 * `formatQuantity`), so the figures can't drift; only the geometry is
 * separate.
 *
 * The layout requirement that drives everything below is the same one
 * that drives the text renderer: **the itemisation has to survive**. A
 * description too long for its column wraps rather than being clipped,
 * and a table that runs past the bottom of the page continues on the
 * next one with its header repeated — a bill whose second page is a
 * column of unlabelled numbers is exactly the sort of thing a client
 * disputes.
 */
export interface InvoicePdfRenderer {
  render(params: RenderInvoiceParams): Promise<Buffer>;
}

/* US Letter, in points. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BOTTOM_LIMIT = 72;

/** Right edge of each right-aligned numeric column, and the left edge of the text ones. */
const COL = {
  date: MARGIN,
  by: MARGIN + 62,
  description: MARGIN + 132,
  quantityRight: PAGE_WIDTH - MARGIN - 150,
  rateRight: PAGE_WIDTH - MARGIN - 78,
  amountRight: PAGE_WIDTH - MARGIN,
};
const DESCRIPTION_WIDTH = COL.quantityRight - COL.description - 12;

const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.85, 0.85);
const DANGER = rgb(0.72, 0.11, 0.11);

const SECTIONS: { source: InvoiceLineItem["source"]; heading: string; quantityLabel: string }[] = [
  { source: "time", heading: "Professional services", quantityLabel: "Hours" },
  { source: "expense", heading: "Expenses and disbursements", quantityLabel: "Qty" },
  { source: "flat", heading: "Fixed fees", quantityLabel: "Qty" },
];

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  card: "Card",
  ach: "Bank transfer",
  check: "Check",
  cash: "Cash",
  trust_application: "Applied from funds held in trust",
  other: "Payment",
};

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on a character
 * they can't represent. Client names, matter captions and free-text
 * descriptions are all arbitrary user input, so an em dash pasted from a
 * word processor — or a name in a script Helvetica has no glyph for —
 * would otherwise turn generating a bill into a 500. The common
 * typographic characters are mapped to their ASCII equivalents and
 * anything still unrepresentable becomes "?", because a slightly
 * degraded character is enormously better than no invoice.
 */
function toWinAnsi(value: string): string {
  return value
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e¡-ÿ]/g, "?");
}

/** Greedy word wrap against the real measured width of the chosen font. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = toWinAnsi(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the column (a long URL, a case citation)
    // is broken by character rather than left to overflow the page.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = "";
      for (const char of word) {
        if (font.widthOfTextAtSize(chunk + char, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Tracks the cursor and starts a new page when the content would run off this one. */
class Layout {
  #doc: PDFDocument;
  pages: PDFPage[] = [];
  page: PDFPage;
  y = PAGE_HEIGHT - MARGIN;

  constructor(doc: PDFDocument) {
    this.#doc = doc;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
  }

  /** Returns true when a page break happened, so a caller can repeat a table header. */
  ensure(height: number): boolean {
    if (this.y - height >= BOTTOM_LIMIT) return false;
    this.page = this.#doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
    return true;
  }

  text(value: string, options: { x: number; size: number; font: PDFFont; color?: typeof INK }): void {
    this.page.drawText(toWinAnsi(value), {
      x: options.x,
      y: this.y,
      size: options.size,
      font: options.font,
      color: options.color ?? INK,
    });
  }

  /** Draws right-aligned at `right`, which is what every money column needs. */
  textRight(value: string, options: { right: number; size: number; font: PDFFont; color?: typeof INK }): void {
    const safe = toWinAnsi(value);
    this.page.drawText(safe, {
      x: options.right - options.font.widthOfTextAtSize(safe, options.size),
      y: this.y,
      size: options.size,
      font: options.font,
      color: options.color ?? INK,
    });
  }

  rule(): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
  }
}

export class PdfLibInvoicePdfRenderer implements InvoicePdfRenderer {
  async render(params: RenderInvoiceParams): Promise<Buffer> {
    const { invoice, totals, payments, firm } = params;
    const names = params.timekeeperNames ?? {};
    const matterTitle = params.matterTitle || invoice.matterId;

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const l = new Layout(doc);

    doc.setTitle(`Invoice ${invoice.number} — ${matterTitle}`);
    doc.setAuthor(firm.name);
    doc.setSubject(`Invoice ${invoice.number}`);
    doc.setProducer("Docket");
    doc.setCreator("Docket");

    /* ---------- letterhead ---------- */
    l.text(firm.name, { x: MARGIN, size: 16, font: bold });
    l.y -= 16;
    for (const line of [...(firm.addressLines ?? []), firm.phone, firm.email].filter(Boolean) as string[]) {
      l.text(line, { x: MARGIN, size: 9, font, color: MUTED });
      l.y -= 11;
    }

    l.y -= 14;
    l.text(`INVOICE ${invoice.number}`, { x: MARGIN, size: 13, font: bold });
    l.y -= 20;

    const meta: [string, string][] = [];
    if (params.clientName) meta.push(["To", params.clientName]);
    meta.push(["Matter", `${matterTitle} (${invoice.matterId})`]);
    meta.push(["Issued", invoice.sentAt ? invoice.sentAt.slice(0, 10) : "draft — not yet issued"]);
    if (invoice.dueDate) meta.push(["Due", invoice.dueDate]);
    for (const [label, value] of meta) {
      l.text(label, { x: MARGIN, size: 9, font, color: MUTED });
      l.text(value, { x: MARGIN + 58, size: 9, font });
      l.y -= 13;
    }

    if (invoice.status === "void") {
      l.y -= 8;
      l.text(`VOID — ${invoice.voidReason ?? "no reason recorded"}`, { x: MARGIN, size: 11, font: bold, color: DANGER });
      l.y -= 16;
    }

    /* ---------- line-item sections ---------- */
    // `showProvenance` is false for a section whose lines carry no date
    // or timekeeper (a flat fee usually doesn't). Printing empty "Date"
    // and "By" headers over blank space looks like missing data on a
    // document a client is being asked to pay.
    const drawTableHeader = (quantityLabel: string, showProvenance: boolean) => {
      if (showProvenance) {
        l.text("Date", { x: COL.date, size: 8, font: bold, color: MUTED });
        l.text("By", { x: COL.by, size: 8, font: bold, color: MUTED });
      }
      l.text("Description", { x: COL.description, size: 8, font: bold, color: MUTED });
      l.textRight(quantityLabel, { right: COL.quantityRight, size: 8, font: bold, color: MUTED });
      l.textRight("Rate", { right: COL.rateRight, size: 8, font: bold, color: MUTED });
      l.textRight("Amount", { right: COL.amountRight, size: 8, font: bold, color: MUTED });
      l.y -= 5;
      l.rule();
      l.y -= 12;
    };

    for (const section of SECTIONS) {
      const lines = invoice.lineItems.filter((item) => item.source === section.source);
      if (lines.length === 0) continue;

      l.y -= 12;
      l.ensure(60);
      l.text(section.heading.toUpperCase(), { x: MARGIN, size: 9, font: bold, color: MUTED });
      l.y -= 14;
      const showProvenance = lines.some((item) => item.workedOn || item.timekeeperId);
      drawTableHeader(section.quantityLabel, showProvenance);

      for (const item of lines) {
        const wrapped = wrap(item.description, font, 9, DESCRIPTION_WIDTH);
        const rowHeight = Math.max(wrapped.length * 11, 11) + 6;
        if (l.ensure(rowHeight)) drawTableHeader(section.quantityLabel, showProvenance);

        l.text(item.workedOn ?? "", { x: COL.date, size: 9, font, color: MUTED });
        l.text(item.timekeeperId ? names[item.timekeeperId] ?? item.timekeeperId : "", {
          x: COL.by,
          size: 9,
          font,
          color: MUTED,
        });
        l.textRight(formatQuantity(item.quantityMilli), { right: COL.quantityRight, size: 9, font });
        l.textRight(formatCents(item.unitAmountCents), { right: COL.rateRight, size: 9, font });
        l.textRight(formatCents(item.amountCents), { right: COL.amountRight, size: 9, font });

        // The description is drawn last because it is the only column
        // that can be several lines tall; the cursor follows it down.
        for (const [index, line] of wrapped.entries()) {
          l.page.drawText(line, { x: COL.description, y: l.y - index * 11, size: 9, font, color: INK });
        }
        l.y -= rowHeight;
      }

      const sectionTotal = lines.reduce((sum, item) => sum + item.amountCents, 0);
      l.y += 2;
      l.rule();
      l.y -= 12;
      l.textRight(`${section.heading} total`, { right: COL.rateRight, size: 9, font, color: MUTED });
      l.textRight(formatCents(sectionTotal), { right: COL.amountRight, size: 9, font: bold });
      l.y -= 6;
    }

    /* ---------- totals ---------- */
    l.ensure(90);
    l.y -= 16;
    const totalLine = (label: string, value: string, emphasise = false) => {
      l.ensure(16);
      l.textRight(label, { right: COL.rateRight, size: emphasise ? 11 : 9, font: emphasise ? bold : font, color: emphasise ? INK : MUTED });
      l.textRight(value, { right: COL.amountRight, size: emphasise ? 11 : 9, font: emphasise ? bold : font });
      l.y -= emphasise ? 18 : 14;
    };

    totalLine("Total", formatCents(totals.subtotalCents));
    for (const payment of payments) {
      totalLine(
        `${payment.recordedAt.slice(0, 10)} — ${PAYMENT_METHOD_LABEL[payment.method] ?? "Payment"}${
          payment.reference ? ` (${payment.reference})` : ""
        }`,
        `-${formatCents(payment.amountCents)}`,
      );
    }
    l.y -= 2;
    l.page.drawLine({
      start: { x: COL.rateRight - 120, y: l.y + 12 },
      end: { x: COL.amountRight, y: l.y + 12 },
      thickness: 1,
      color: INK,
    });
    totalLine("Balance due", formatCents(totals.balanceCents), true);

    /* ---------- notes ---------- */
    for (const note of [invoice.note, firm.paymentInstructions].filter(Boolean) as string[]) {
      l.y -= 10;
      for (const line of wrap(note, font, 9, PAGE_WIDTH - MARGIN * 2)) {
        l.ensure(12);
        l.text(line, { x: MARGIN, size: 9, font, color: MUTED });
        l.y -= 12;
      }
    }

    /* ---------- page numbers ---------- */
    // Added at the end, when the total is finally known — a client asked
    // to check a bill needs to know whether they have all of it.
    if (l.pages.length > 1) {
      for (const [index, page] of l.pages.entries()) {
        const label = `${invoice.number}   Page ${index + 1} of ${l.pages.length}`;
        page.drawText(label, {
          x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(label, 8),
          y: MARGIN - 18,
          size: 8,
          font,
          color: MUTED,
        });
      }
    }

    return Buffer.from(await doc.save({ useObjectStreams: true }));
  }
}

/** `INV-00001 State v. Ruiz.pdf`, sanitised for a filesystem and for a Content-Disposition header. */
export function invoicePdfFilename(invoiceNumber: string, matterTitle: string): string {
  const safe = toWinAnsi(`${invoiceNumber} ${matterTitle}`)
    .replace(/[^\w\-. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe || invoiceNumber}.pdf`;
}
