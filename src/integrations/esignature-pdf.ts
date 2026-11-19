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

  const field = (label: string, value: string) => {
    ensure(14);
    page.drawText(label, { x: MARGIN, y, size: 8, font: bold, color: MUTED });
    for (const line of wrap(value, font, 9, maxWidth - 90)) {
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
