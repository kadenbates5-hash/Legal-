import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ESignatureService } from "../src/review-ui/esignature-service.js";
import { ESignatureStore } from "../src/core/esignature.js";
import { EsignatureError } from "../src/core/esignature.js";
import { DocumentStore } from "../src/core/document-store.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { EmailSender, EmailResult } from "../src/integrations/email-sender.js";
import { asTyped } from "../src/integrations/esignature-pdf.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

class FakeEmailSender implements EmailSender {
  readonly name = "fake";
  readonly canSend = true;
  readonly fromAddress = "firm@example.com";
  sent: { to: string; subject: string }[] = [];
  async send(message: { to: string; subject: string }): Promise<EmailResult> {
    this.sent.push({ to: message.to, subject: message.subject });
    return { messageId: "msg_1" };
  }
}

function makeEnv(opts?: { email?: EmailSender }) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const documents = new DocumentStore();
  const workProducts = new WorkProductStore();
  const store = new ESignatureStore();
  const esignature = new ESignatureService({
    store,
    accessControl,
    auditLog,
    documents,
    workProducts,
    baseUrl: "https://docket.example.com",
    ...(opts?.email ? { email: opts.email } : {}),
  });
  return { esignature, documents, workProducts, accessControl, auditLog, store };
}

async function realPdfBase64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return Buffer.from(await doc.save()).toString("base64");
}

/** A real one-page PDF: `send()` now refuses a file that can't be opened as one. */
const PDF = await realPdfBase64();

function releasedWorkProduct(matterId = "m1", content = "Dear Client, this confirms our engagement."): WorkProduct {
  const wp = new WorkProduct({ id: "wp_1", matterId, kind: "engagement_letter", content }, new AuditLog());
  wp.submitForReview(paralegal);
  wp.approve(attorney);
  wp.release(attorney);
  return wp;
}

describe("ESignatureService.send", () => {
  it("denies receptionists entirely", async () => {
    const { esignature, documents } = makeEnv();
    documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "a1" });
    await expect(
      esignature.send(receptionist, { matterId: "m1", title: "x", sourceKind: "document", sourceId: "doc_1", signers: [{ name: "X", email: "x@example.com" }] }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("denies a paralegal not assigned to the matter", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m2", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "a1" });
    await expect(
      esignature.send(paralegal, { matterId: "m2", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("sends a staff-uploaded PDF document for signature", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "engagement.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const result = await esignature.send(paralegal, {
      matterId: "m1",
      title: "Engagement Letter",
      sourceKind: "document",
      sourceId: doc.id,
      signers: [{ name: "Jane Doe", email: "jane@example.com" }],
    });
    expect(result.envelope.status).toBe("sent");
    expect(result.envelope.signers).toHaveLength(1);
    expect(result.signingUrls[result.envelope.signers[0]!.id]).toContain("https://docket.example.com/sign.html?token=");
    expect(result.emailed).toBe(false); // no EmailSender configured in this env
  });

  it("refuses a non-PDF document", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "notes.txt", contentType: "text/plain", content: "aGVsbG8=", uploadedBy: "p1" });
    await expect(
      esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] }),
    ).rejects.toThrow(/not a PDF/);
  });

  it("refuses to send a work product that hasn't been released by an attorney yet", async () => {
    const { esignature, workProducts } = makeEnv();
    const wp = new WorkProduct({ id: "wp_draft", matterId: "m1", kind: "engagement_letter", content: "draft text" }, new AuditLog());
    workProducts.register(wp);
    await expect(
      esignature.send(attorney, { matterId: "m1", title: "x", sourceKind: "work_product", sourceId: "wp_draft", signers: [{ name: "X", email: "x@example.com" }] }),
    ).rejects.toThrow(/must be released/);

    wp.submitForReview(paralegal);
    await expect(
      esignature.send(attorney, { matterId: "m1", title: "x", sourceKind: "work_product", sourceId: "wp_draft", signers: [{ name: "X", email: "x@example.com" }] }),
    ).rejects.toThrow(/must be released/);
  });

  it("sends a released work product, rendering it to a PDF", async () => {
    const { esignature, workProducts } = makeEnv();
    workProducts.register(releasedWorkProduct());
    const result = await esignature.send(attorney, {
      matterId: "m1",
      title: "Engagement Letter",
      sourceKind: "work_product",
      sourceId: "wp_1",
      signers: [{ name: "Jane Doe", email: "jane@example.com" }],
    });
    expect(result.envelope.status).toBe("sent");
  });

  it("emails each signer their own signing link when a real EmailSender is configured", async () => {
    const email = new FakeEmailSender();
    const { esignature, documents } = makeEnv({ email });
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const result = await esignature.send(paralegal, {
      matterId: "m1",
      title: "Engagement Letter",
      sourceKind: "document",
      sourceId: doc.id,
      signers: [{ name: "Jane Doe", email: "jane@example.com" }, { name: "John Roe", email: "john@example.com" }],
    });
    expect(result.emailed).toBe(true);
    expect(email.sent.map((m) => m.to)).toEqual(["jane@example.com", "john@example.com"]);
  });

  it("audits the send", async () => {
    const { esignature, documents, auditLog } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] });
    expect(auditLog.read("attorney").some((e) => e.action === "esignature_sent")).toBe(true);
  });
});

describe("ESignatureService — staff reads and void", () => {
  it("lists and gets envelopes scoped to the matter", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const { envelope } = await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] });
    expect(esignature.listByMatter(attorney, "m1")).toHaveLength(1);
    expect(esignature.get(attorney, "m1", envelope.id).id).toBe(envelope.id);
  });

  it("voiding is attorney-only", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const { envelope } = await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] });
    expect(() => esignature.void(paralegal, "m1", envelope.id, "changed terms")).toThrow(AccessDeniedError);
    const voided = esignature.void(attorney, "m1", envelope.id, "changed terms");
    expect(voided.status).toBe("voided");
  });

  it("downloading the final PDF before completion fails", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const { envelope } = await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] });
    await expect(esignature.downloadFinal(attorney, "m1", envelope.id)).rejects.toThrow(EsignatureError);
  });
});

describe("ESignatureService — signer-facing (no Actor at all)", () => {
  it("drives a full sign-and-complete flow via the bearer token", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: await realPdfBase64(), uploadedBy: "p1" });
    const { envelope, signingUrls } = await esignature.send(paralegal, {
      matterId: "m1",
      title: "Engagement Letter",
      sourceKind: "document",
      sourceId: doc.id,
      signers: [{ name: "Jane Doe", email: "jane@example.com" }],
    });
    const token = new URL(signingUrls[envelope.signers[0]!.id]!).searchParams.get("token")!;

    const status = esignature.getForSigner(token);
    expect(status.signerName).toBe("Jane Doe");
    expect(status.signerStatus).toBe("pending");

    const doc2 = esignature.getDocumentForSigner(token);
    expect(doc2.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    await esignature.sign(token, { signatureText: "Jane Doe", ipAddress: "127.0.0.1" });

    const completed = esignature.get(attorney, "m1", envelope.id);
    expect(completed.status).toBe("completed");
    expect(completed.signers[0]!.status).toBe("signed");

    // The final, certificate-stamped PDF is now downloadable.
    const final = await esignature.downloadFinal(attorney, "m1", envelope.id);
    expect(final.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // The token is single-use.
    await expect(esignature.sign(token, { signatureText: "Jane Doe" })).rejects.toThrow(EsignatureError);
  });

  it("rejects an unknown token on every signer-facing method", async () => {
    const { esignature } = makeEnv();
    expect(() => esignature.getForSigner("bogus")).toThrow(EsignatureError);
    expect(() => esignature.getDocumentForSigner("bogus")).toThrow(EsignatureError);
    await expect(esignature.sign("bogus", { signatureText: "X" })).rejects.toThrow(EsignatureError);
    expect(() => esignature.decline("bogus", "no")).toThrow(EsignatureError);
  });

  it("refuses to sign with blank text", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const { signingUrls, envelope } = await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "X", email: "x@example.com" }] });
    const token = new URL(signingUrls[envelope.signers[0]!.id]!).searchParams.get("token")!;
    await expect(esignature.sign(token, { signatureText: "   " })).rejects.toThrow(/type your name/);
  });

  it("lets a signer decline, which audits with their email as the actor id", async () => {
    const { esignature, documents, auditLog } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "p1" });
    const { signingUrls, envelope } = await esignature.send(paralegal, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: "Jane Doe", email: "jane@example.com" }] });
    const token = new URL(signingUrls[envelope.signers[0]!.id]!).searchParams.get("token")!;
    esignature.decline(token, "disagree with terms");

    const updated = esignature.get(attorney, "m1", envelope.id);
    expect(updated.status).toBe("declined");
    const entry = auditLog.read("attorney").find((e) => e.action === "esignature_declined");
    expect(entry?.actor.id).toBe("jane@example.com");
    expect(entry?.actor.role).toBe("anonymous");
  });
});

describe("a document that can't carry a certificate", () => {
  it("is refused when it's sent, not when the last person signs it", async () => {
    const { esignature, documents } = makeEnv();
    for (const content of [Buffer.from("%PDF-fake").toString("base64"), PDF.slice(0, 40)]) {
      const doc = documents.upload({ matterId: "m1", fileName: "plea.pdf", contentType: "application/pdf", content, uploadedBy: "a1" });
      await expect(
        esignature.send(attorney, { matterId: "m1", title: "Plea", sourceKind: "document", sourceId: doc.id, signers: [{ name: "Dana Cole", email: "dana@example.com" }] }),
      ).rejects.toThrow(/couldn't be opened as a PDF — it may be damaged or password-protected/);
    }
  });

  it("still audits a signature when the certificate can't be built, and says so on download", async () => {
    const { esignature, store, auditLog } = makeEnv();
    // What an envelope sent before the send-time check could hold.
    const { envelope, tokens } = store.create({
      matterId: "m1",
      title: "Plea",
      sourceKind: "document",
      sourceId: "doc_old",
      documentHash: "x",
      pdfContent: Buffer.from("not a pdf").toString("base64"),
      createdBy: "a1",
      signers: [{ name: "Dana Cole", email: "dana@example.com" }],
    });
    // The signer's signature stands, so they aren't shown an error for it.
    await expect(esignature.sign(tokens[envelope.signers[0]!.id]!, { signatureText: "Dana Cole" })).resolves.toBeUndefined();
    const actions = auditLog.read("attorney").map((e) => e.action);
    expect(actions).toContain("esignature_signed");
    expect(actions).toContain("esignature_certificate_failed");
    await expect(esignature.downloadFinal(attorney, "m1", envelope.id)).rejects.toThrow(/every signer has signed .* couldn't be produced/);
  });
});

describe("names on a signature", () => {
  it("are capped where staff enter them and where the signer types them", async () => {
    const { esignature, documents } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "a1" });
    const long = "N".repeat(201);
    await expect(
      esignature.send(attorney, { matterId: "m1", title: "x", sourceKind: "document", sourceId: doc.id, signers: [{ name: long, email: "x@example.com" }] }),
    ).rejects.toThrow(/at most 200 characters/);
    const { envelope, signingUrls } = await esignature.send(attorney, {
      matterId: "m1",
      title: "x",
      sourceKind: "document",
      sourceId: doc.id,
      signers: [{ name: "Łukasz Nowak", email: "l@example.com" }],
    });
    const token = new URL(signingUrls[envelope.signers[0]!.id]!).searchParams.get("token")!;
    await expect(esignature.sign(token, { signatureText: long })).rejects.toThrow(/at most 200 characters/);
    await esignature.sign(token, { signatureText: "Łukasz Nowak" });
    expect((await esignature.downloadFinal(attorney, "m1", envelope.id)).data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("are recorded on the certificate exactly, even in a script its font can't draw", () => {
    expect(asTyped("Łukasz Nowak")).toBe("?ukasz Nowak (as typed: U+0141 ukasz Nowak)");
    expect(asTyped("李明")).toBe("?? (as typed: U+674E U+660E)");
    // Characters the font has, and punctuation it swaps for a plain twin, aren't spelled out.
    expect(asTyped("José O’Brien")).toBe("José O'Brien");
  });
});

describe("a signer declining", () => {
  it("keeps a long reason to a sensible length instead of storing it whole, and still records the decline", async () => {
    const { esignature, documents, auditLog } = makeEnv();
    const doc = documents.upload({ matterId: "m1", fileName: "x.pdf", contentType: "application/pdf", content: PDF, uploadedBy: "a1" });
    const { envelope, signingUrls } = await esignature.send(attorney, {
      matterId: "m1",
      title: "x",
      sourceKind: "document",
      sourceId: doc.id,
      signers: [{ name: "Dana Cole", email: "dana@example.com" }],
    });
    esignature.decline(new URL(signingUrls[envelope.signers[0]!.id]!).searchParams.get("token")!, "r".repeat(900_000));
    const declined = esignature.get(attorney, "m1", envelope.id);
    expect(declined.status).toBe("declined");
    const reason = declined.signers[0]!.declineReason!;
    expect(reason.length).toBeLessThan(2100);
    expect(reason.endsWith("(shortened)")).toBe(true);
    const entry = auditLog.read("attorney").find((e) => e.action === "esignature_declined")!;
    expect(entry.detail.length).toBeLessThan(2300);
  });
});
