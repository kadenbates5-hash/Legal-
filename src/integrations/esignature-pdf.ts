import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/**
 * The two pieces of PDF work e-signature needs, over the `pdf-lib` this
 * project already depends on for invoices and condensing:
 *
 * 1. Turning a released `WorkProduct`'s plain-text content into a PDF in
 *    the first place — drafts in this system have never had a PDF form
 *    before, since invoices were the only thing that needed one.
 * 2. Stamping a **certificate of completion** onto the signed result:
 *    the document's hash and every signer's name/email/timestamp/IP,
 *    appended as a final page. This is what gives a signed PDF here any
 *    evidentiary weight at all — the same "accountability has to be
 *    provable, not just asserted" reasoning as the audit log's hash
 *    chain, applied to a single document instead of the whole log.
 *
 * Both are exported standalone and unit-testable without any live
 * service, same pattern as `invoice-pdf.ts`'s `invoicePdfFilename`.
 */

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const INK = rgb(0.07, 0.07, 0.07);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.85, 0.85);

/** Same WinAnsi-safety reasoning as `invoice-pdf.ts`'s `toWinAnsi` — drafted/typed text is arbitrary input, and pdf-lib's standard fonts throw on a glyph they don't have. */
function toWinAnsi(value: string): string {
  return value
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[\r\n\t]+/g, (m) => (m.includes("\n") ? "\n" : " "))
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e\xa1-\xff\n]/g, "?");
}

/**
 * A value for the certificate, with nothing lost. The standard fonts
 * can't draw "Ł" or "李", and `toWinAnsi` prints those as "?" — fine in a
 * drafted letter, but a certificate whose job is to say who signed would
 * read "?ukasz" or "??". Such a value is followed by every character
 * written as a code point, so the record can still be read exactly.
 */
export function asTyped(value: string): string {
  const drawable = toWinAnsi(value);
  // The punctuation toWinAnsi swaps for a plain equivalent isn't a loss.
  const swappedPunctuation = /[\u2018\u2019\u201a\u2032\u201c\u201d\u201e\u2033\u2013\u2014\u2212\u2026\u00a0\r\t]/g;
  if (!/[^\x20-\x7e\xa1-\xff\n]/.test(value.replace(swappedPunctuation, ""))) return drawable;
  const codes = [...value]
    .map((c) => (/^[\x20-\x7e]$/.test(c) ? c : ` U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} `))
    .join("");
  return `${drawable} (as typed: ${codes.replace(/\s+/g, " ").trim()})`;
}

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

/**
 * Whether these bytes are a PDF the certificate can later be appended to.
 * Checked when a document is *sent*, because the certificate is built
 * only when the last signer signs: a damaged or password-protected file
 * (pdf-lib refuses encrypted ones) used to be accepted, and then failed
 * at that last signature — after it was recorded, so the signer saw a
 * parser error, the envelope read "completed" with no signed copy, and
 * the signature never reached the audit log.
 */
export async function canStampPdf(bytes: Buffer): Promise<boolean> {
  try {
    await PDFDocument.load(bytes);
    return true;
  } catch {
    return false;
  }
}

/** SHA-256 hex of the exact bytes a signer will be shown — what every signature on this envelope is bound to. */
export function documentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Renders a released `WorkProduct`'s plain-text content as a one-off PDF
 * for signing. Deliberately minimal — a title, the text paragraph-wrapped
 * with blank-line-separated paragraphs preserved, paginated — because the
 * only thing this has to do well is survive `stampCertificateOfCompletion`
 * appending a page afterward; it is not trying to replace `invoice-pdf.ts`'s
 * tabular layout for a different kind of document.
 */
export async function renderPlainTextPdf(title: string, content: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(title);
  doc.setProducer("Docket");
  doc.setCreator("Docket");

  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensure = (height: number) => {
    if (y - height >= MARGIN) return;
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  ensure(24);
  page.drawText(toWinAnsi(title), { x: MARGIN, y, size: 14, font: bold, color: INK });
  y -= 28;

  const paragraphs = content.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const lines = wrap(paragraph.replace(/\n/g, " "), font, 10, maxWidth);
    for (const line of lines) {
      ensure(14);
      page.drawText(line, { x: MARGIN, y, size: 10, font, color: INK });
      y -= 14;
    }
    y -= 10;
  }

  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

export interface CertificateSigner {
  name: string;
  email: string;
  signatureText: string | undefined;
  signedAt: string | undefined;
  ipAddress: string | undefined;
}

/**
 * Loads an already-sent PDF and appends a certificate-of-completion page
 * naming the document's hash and every signer's name/email/signature
 * text/timestamp/IP — the record that makes "this was actually signed,
 * by these people, on this document" a provable claim rather than an
 * assertion, the same evidentiary purpose the audit log's hash chain
 * serves for the firm's activity record generally.
 */
export async function stampCertificateOfCompletion(
  originalPdfBytes: Buffer,
  params: { envelopeId: string; title: string; hash: string; signers: CertificateSigner[] },
): Promise<Buffer> {
  const doc = await PDFDocument.load(originalPdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const ensure = (height: number) => {
    if (y - height >= MARGIN) return;
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  page.drawText("Certificate of Completion", { x: MARGIN, y, size: 15, font: bold, color: INK });
  y -= 22;
  page.drawText(toWinAnsi(params.title), { x: MARGIN, y, size: 10, font, color: MUTED });
  y -= 18;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: RULE });
  y -= 18;

  // Room is checked on every line, not once per field: a long value used
  // to run off the bottom of the page, and what ran off isn't on the
  // certificate at all.
  const field = (label: string, value: string) => {
    for (const [i, line] of wrap(asTyped(value), font, 9, maxWidth - 90).entries()) {
      ensure(14);
      if (i === 0) page.drawText(label, { x: MARGIN, y, size: 8, font: bold, color: MUTED });
      page.drawText(line, { x: MARGIN + 90, y, size: 9, font, color: INK });
      y -= 12;
    }
  };

  field("Envelope ID", params.envelopeId);
  field("Document SHA-256", params.hash);
  y -= 10;

  for (const [index, signer] of params.signers.entries()) {
    ensure(70);
    page.drawText(`Signer ${index + 1}`, { x: MARGIN, y, size: 10, font: bold, color: INK });
    y -= 16;
    field("Name", signer.name);
    field("Email", signer.email);
    field("Signed as", signer.signatureText ?? "(not signed)");
    field("Signed at", signer.signedAt ?? "(not signed)");
    field("IP address", signer.ipAddress ?? "(unavailable)");
    y -= 12;
  }

  return Buffer.from(await doc.save({ useObjectStreams: true }));
}
