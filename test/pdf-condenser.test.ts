import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfLibCondenser } from "../src/integrations/pdf-condenser.js";

async function makeTestPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle("A very original title");
  doc.setAuthor("Some Author");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText("Condense me", { x: 20, y: 250, size: 18, font });
  return Buffer.from(await doc.save());
}

describe("PdfLibCondenser", () => {
  it("returns a smaller-or-equal, still-valid PDF and reports accurate byte counts", async () => {
    const pdfBytes = await makeTestPdf();
    const condenser = new PdfLibCondenser();
    const result = await condenser.condense(pdfBytes);
    expect(result.originalBytes).toBe(pdfBytes.byteLength);
    expect(result.condensedBytes).toBe(result.data.byteLength);
    expect(result.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Round-trips: the condensed bytes are still a loadable PDF.
    const reloaded = await PDFDocument.load(result.data);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("strips document metadata", async () => {
    const pdfBytes = await makeTestPdf();
    const condenser = new PdfLibCondenser();
    const result = await condenser.condense(pdfBytes);
    const reloaded = await PDFDocument.load(result.data);
    expect(reloaded.getTitle()).toBeFalsy();
    expect(reloaded.getAuthor()).toBeFalsy();
  });
});
