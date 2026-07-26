import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfParseTextExtractor } from "../src/integrations/pdf-text.js";

async function makeTestPdf(text: string, pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 250, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

describe("PdfParseTextExtractor", () => {
  it("extracts the text layer from a real PDF", async () => {
    const pdfBytes = await makeTestPdf("Hello from a test PDF");
    const extractor = new PdfParseTextExtractor();
    const result = await extractor.extractText(pdfBytes);
    expect(result.text).toContain("Hello from a test PDF");
    expect(result.pageCount).toBe(1);
  });

  it("reports the correct page count for a multi-page PDF", async () => {
    const pdfBytes = await makeTestPdf("Page text", 3);
    const extractor = new PdfParseTextExtractor();
    const result = await extractor.extractText(pdfBytes);
    expect(result.pageCount).toBe(3);
  });

  it("returns no real text for a page with no text layer (e.g. a scanned/image-only page)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const pdfBytes = Buffer.from(await doc.save());
    const extractor = new PdfParseTextExtractor();
    const result = await extractor.extractText(pdfBytes);
    // pdf-parse still emits its page-separator marker even for a blank page —
    // what matters is there's no actual extracted content alongside it.
    expect(result.text.replace(/--\s*\d+\s*of\s*\d+\s*--/g, "").trim()).toBe("");
  });
});
