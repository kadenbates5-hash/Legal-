import { describe, expect, it } from "vitest";
import { PdfReportService } from "../src/review-ui/pdf-report-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentStore } from "../src/core/document-store.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { PdfTextExtractor } from "../src/integrations/pdf-text.js";
import type { PdfCondenser } from "../src/integrations/pdf-condenser.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

class FakeExtractor implements PdfTextExtractor {
  async extractText() {
    return { text: "Extracted contract text.", pageCount: 2 };
  }
}

class FakeCondenser implements PdfCondenser {
  async condense(pdfBytes: Buffer) {
    const data = Buffer.from(pdfBytes.subarray(0, Math.max(1, Math.floor(pdfBytes.byteLength / 2))));
    return { data, originalBytes: pdfBytes.byteLength, condensedBytes: data.byteLength };
  }
}

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const documents = new DocumentsService({ accessControl, store: new DocumentStore() });
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: new WorkProductStore() });
  const pdfReports = new PdfReportService({ documents, drafting, extractor: new FakeExtractor(), condenser: new FakeCondenser() });
  return { documents, drafting, pdfReports };
}

const samplePdfBase64 = Buffer.from("%PDF-1.4 fake pdf bytes for testing").toString("base64");

describe("PdfReportService", () => {
  it("drafts a report from an uploaded PDF's extracted text", async () => {
    const { documents, pdfReports } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "contract.pdf", contentType: "application/pdf", content: samplePdfBase64 });
    const wp = await pdfReports.draftReportFromDocument(paralegal, "m1", doc.id);
    expect(wp.content).toContain("Extracted contract text.");
    expect(wp.flags).toContain("pdf_extraction_requires_attorney_verification");
  });

  it("rejects drafting a report from a non-PDF document", async () => {
    const { documents, pdfReports } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "notes.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") });
    await expect(pdfReports.draftReportFromDocument(paralegal, "m1", doc.id)).rejects.toThrow(/not a PDF/);
  });

  it("denies a receptionist entirely", async () => {
    const { documents, pdfReports } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "contract.pdf", contentType: "application/pdf", content: samplePdfBase64 });
    await expect(pdfReports.draftReportFromDocument(receptionist, "m1", doc.id)).rejects.toThrow(AccessDeniedError);
  });

  it("condenses a PDF and stores the result as a new document, leaving the original untouched", async () => {
    const { documents, pdfReports } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "contract.pdf", contentType: "application/pdf", content: samplePdfBase64 });
    const result = await pdfReports.condenseDocument(paralegal, "m1", doc.id);
    expect(result.condensedDocument.fileName).toBe("contract (condensed).pdf");
    expect(result.condensedBytes).toBeLessThan(result.originalBytes);

    const allDocs = documents.listMatterDocuments(paralegal, "m1");
    expect(allDocs).toHaveLength(2);
    expect(allDocs.some((d) => d.id === doc.id)).toBe(true);
  });

  it("denies drafting/condensing on a matter the paralegal isn't assigned to", async () => {
    const { documents, pdfReports } = makeService();
    const doc = documents.upload(paralegal, "m1", { fileName: "contract.pdf", contentType: "application/pdf", content: samplePdfBase64 });
    await expect(pdfReports.draftReportFromDocument(paralegal, "m2", doc.id)).rejects.toThrow();
  });
});
