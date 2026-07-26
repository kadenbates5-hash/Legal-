import { PDFDocument } from "pdf-lib";

/**
 * Best-effort PDF size reduction, behind a vendor-agnostic interface (same
 * pattern as `PdfTextExtractor`). `pdf-lib` (pure JS, no Ghostscript/native
 * binary dependency) rewrites the PDF's internal object structure using
 * compressed cross-reference/object streams and strips metadata — this
 * meaningfully shrinks PDFs with many small objects (e.g. exported from
 * word processors, form-heavy documents), but it does **not** recompress
 * or downsample embedded images. A scanned, image-heavy PDF will see
 * little to no reduction — real image recompression needs an image codec
 * (or an external tool like Ghostscript), which is deliberately out of
 * scope here, the same "not a substitute for a real tool" caveat this
 * project already gives Voicebox/CourtListener for their own limits.
 */
export interface PdfCondenseResult {
  data: Buffer;
  originalBytes: number;
  condensedBytes: number;
}

export interface PdfCondenser {
  condense(pdfBytes: Buffer): Promise<PdfCondenseResult>;
}

export class PdfLibCondenser implements PdfCondenser {
  async condense(pdfBytes: Buffer): Promise<PdfCondenseResult> {
    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    doc.setTitle("");
    doc.setAuthor("");
    doc.setSubject("");
    doc.setKeywords([]);
    doc.setCreator("");
    doc.setProducer("");
    const condensed = await doc.save({ useObjectStreams: true });
    const data = Buffer.from(condensed);
    return { data, originalBytes: pdfBytes.byteLength, condensedBytes: data.byteLength };
  }
}
