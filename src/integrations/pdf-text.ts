import { PDFParse } from "pdf-parse";

/**
 * Text extraction from an uploaded PDF, behind a vendor-agnostic interface
 * — same pattern as `CaseLawSearchClient`/`ClaudeClient` elsewhere in
 * `integrations/`: a real implementation plus room for a test double that
 * doesn't need a real PDF file. `pdf-parse` (pure JS, no native/system
 * dependency like Ghostscript) is a deliberate, justified exception to
 * this project's otherwise dependency-light style — reimplementing PDF
 * text extraction from scratch isn't a reasonable ask, same reasoning as
 * `pg` being the one justified exception before this.
 */
export interface PdfTextExtractionResult {
  text: string;
  pageCount: number;
}

export interface PdfTextExtractor {
  extractText(pdfBytes: Buffer): Promise<PdfTextExtractionResult>;
}

/**
 * `pdf-parse` extracts real text layers (the characters a PDF viewer would
 * let you select/copy) — it does not OCR scanned/image-only pages, so a
 * scanned document will come back with little or no text. That limitation
 * is exactly why `draftDocumentReport` (see `paralegal/drafting.ts`)
 * unconditionally flags its output for attorney verification, the same
 * way `draftResearchSummary` always flags citations.
 */
export class PdfParseTextExtractor implements PdfTextExtractor {
  async extractText(pdfBytes: Buffer): Promise<PdfTextExtractionResult> {
    // A Node `Buffer` can be a view into a shared, pooled `ArrayBuffer` (for
    // small allocations) — pdf-parse hands the bytes to pdfjs-dist's worker
    // via `structuredClone`'s transfer list, which requires an ArrayBuffer
    // it fully owns. Copying into a fresh Uint8Array guarantees that.
    const parser = new PDFParse({ data: new Uint8Array(pdfBytes) });
    try {
      // Sequenced, not Promise.all: both calls load the document via the
      // same underlying buffer, which pdfjs-dist's worker transport
      // transfers (neuters) on first use — running them concurrently races
      // two transfers of the same buffer and throws DataCloneError.
      const textResult = await parser.getText();
      const infoResult = await parser.getInfo();
      return { text: textResult.text, pageCount: infoResult.total };
    } finally {
      await parser.destroy();
    }
  }
}
