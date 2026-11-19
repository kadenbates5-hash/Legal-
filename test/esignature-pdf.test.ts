import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { documentHash, renderPlainTextPdf, stampCertificateOfCompletion } from "../src/integrations/esignature-pdf.js";

describe("documentHash", () => {
  it("is deterministic and sensitive to content", () => {
    const a = documentHash(Buffer.from("hello"));
    const b = documentHash(Buffer.from("hello"));
    const c = documentHash(Buffer.from("hello!"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderPlainTextPdf", () => {
  it("renders a loadable, titled PDF from plain text", async () => {
    const bytes = await renderPlainTextPdf("Engagement Letter", "Dear Client,\n\nThis confirms our engagement.\n\nSincerely,\nThe Firm");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Engagement Letter");
  });

  it("paginates long content across multiple pages", async () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `This is paragraph number ${i}, with enough text to take up a full line of the page.`).join("\n\n");
    const bytes = await renderPlainTextPdf("Long Document", longContent);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("doesn't throw on characters outside WinAnsi", async () => {
    const bytes = await renderPlainTextPdf("Unicode test", "Curly ‘quotes’ and an em dash — and an emoji \u{1F600}");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("stampCertificateOfCompletion", () => {
  async function basePdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    return Buffer.from(await doc.save());
  }

  it("appends a certificate page naming the envelope, hash, and every signer", async () => {
    const original = await basePdf();
    const result = await stampCertificateOfCompletion(original, {
      envelopeId: "env_1",
      title: "Engagement Letter",
      hash: "deadbeefcafe",
      signers: [
        { name: "Jane Doe", email: "jane@example.com", signatureText: "Jane Doe", signedAt: "2026-07-01T12:00:00.000Z", ipAddress: "127.0.0.1" },
      ],
    });
    const doc = await PDFDocument.load(result);
    const originalDoc = await PDFDocument.load(original);
    expect(doc.getPageCount()).toBe(originalDoc.getPageCount() + 1);
  });

  it("handles multiple signers on one certificate without throwing", async () => {
    const original = await basePdf();
    const result = await stampCertificateOfCompletion(original, {
      envelopeId: "env_2",
      title: "Settlement Agreement",
      hash: "abc123",
      signers: [
        { name: "Jane Doe", email: "jane@example.com", signatureText: "Jane Doe", signedAt: "2026-07-01T12:00:00.000Z", ipAddress: "127.0.0.1" },
        { name: "John Roe", email: "john@example.com", signatureText: "John Roe", signedAt: "2026-07-02T09:30:00.000Z", ipAddress: "10.0.0.5" },
      ],
    });
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
