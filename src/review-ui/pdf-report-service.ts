import { AccessDeniedError, type Actor } from "../core/types.js";
import type { DocumentsService, DocumentSummary, DocumentWithContent } from "./documents-service.js";
import type { DraftingService, WorkProductDetail } from "./drafting-service.js";
import type { PdfTextExtractor } from "../integrations/pdf-text.js";
import type { PdfCondenser } from "../integrations/pdf-condenser.js";

const PDF_CONTENT_TYPE = "application/pdf";

function requirePdf(doc: DocumentSummary): void {
  if (doc.contentType !== PDF_CONTENT_TYPE && !doc.fileName.toLowerCase().endsWith(".pdf")) {
    throw new Error(`document '${doc.id}' ('${doc.fileName}') is not a PDF`);
  }
}

function requireDraftingRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`PDF reports/condensing are paralegal/attorney-only (got role '${actor.role}')`);
  }
}

export interface PdfCondenseSummary {
  originalDocument: DocumentSummary;
  condensedDocument: DocumentSummary;
  originalBytes: number;
  condensedBytes: number;
}

/**
 * Backs the Cases panel's "Draft report" and "Condense" actions on an
 * uploaded PDF. Deliberately a thin composition layer over
 * `DocumentsService` (already the access-controlled gate on a matter's
 * uploaded files) and `DraftingService` (already the access-controlled
 * gate on drafting work product) — this class adds no `AccessControl`
 * checks of its own beyond the role check, since every store access it
 * makes already goes through one of those two services' own checks.
 */
export class PdfReportService {
  #documents: DocumentsService;
  #drafting: DraftingService;
  #extractor: PdfTextExtractor;
  #condenser: PdfCondenser;

  constructor(params: {
    documents: DocumentsService;
    drafting: DraftingService;
    extractor: PdfTextExtractor;
    condenser: PdfCondenser;
  }) {
    this.#documents = params.documents;
    this.#drafting = params.drafting;
    this.#extractor = params.extractor;
    this.#condenser = params.condenser;
  }

  /** Extracts text from an uploaded PDF and drafts it into a reviewable `WorkProduct` report. */
  async draftReportFromDocument(actor: Actor, matterId: string, documentId: string): Promise<WorkProductDetail> {
    requireDraftingRole(actor);
    const doc = this.#documents.getWithContent(actor, matterId, documentId);
    requirePdf(doc);
    const pdfBytes = Buffer.from(doc.content, "base64");
    const { text, pageCount } = await this.#extractor.extractText(pdfBytes);
    return this.#drafting.draftDocumentReport(actor, matterId, {
      sourceDocumentId: doc.id,
      sourceFileName: doc.fileName,
      extractedText: text,
      pageCount,
    });
  }

  /**
   * Shrinks an uploaded PDF and stores the result as a *new* document
   * (named `<original> (condensed).pdf`) rather than overwriting the
   * original — the source file a paralegal uploaded should stay
   * retrievable exactly as uploaded, same reasoning as `reviseDraft`
   * never mutating an already-submitted `WorkProduct` in place.
   */
  async condenseDocument(actor: Actor, matterId: string, documentId: string): Promise<PdfCondenseSummary> {
    requireDraftingRole(actor);
    const doc = this.#documents.getWithContent(actor, matterId, documentId);
    requirePdf(doc);
    const pdfBytes = Buffer.from(doc.content, "base64");
    const { data, originalBytes, condensedBytes } = await this.#condenser.condense(pdfBytes);
    const condensedName = doc.fileName.toLowerCase().endsWith(".pdf")
      ? `${doc.fileName.slice(0, -4)} (condensed).pdf`
      : `${doc.fileName} (condensed).pdf`;
    const condensedDocument = this.#documents.upload(actor, matterId, {
      fileName: condensedName,
      contentType: PDF_CONTENT_TYPE,
      content: data.toString("base64"),
    });
    return { originalDocument: doc, condensedDocument, originalBytes, condensedBytes };
  }
}
