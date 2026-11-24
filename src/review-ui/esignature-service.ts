import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import { ESignatureStore, EsignatureError, type SignatureEnvelope, type Signer } from "../core/esignature.js";
import type { DocumentStore } from "../core/document-store.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import { assertSafeEmailAddress, type EmailSender } from "../integrations/email-sender.js";
import { canStampPdf, documentHash, renderPlainTextPdf, stampCertificateOfCompletion } from "../integrations/esignature-pdf.js";

/** A signer's name, as staff enter it and as the signer types it — long enough for any real name, short enough to fit the certificate. */
const MAX_NAME_LENGTH = 200;

/**
 * The paralegal/attorney-facing surface backing a "Signatures" panel —
 * getting an already-attorney-approved document actually signed, by
 * whoever needs to sign it (a client, a witness, opposing counsel on a
 * stipulation — the signer is deliberately **not** assumed to be a
 * Docket user of any kind, so this never goes through the client portal
 * or `AccessControl`'s `client_portal` category at all).
 *
 * Two different trust boundaries live in this one service, matching the
 * two different callers: staff-facing methods take an `Actor` and go
 * through `AccessControl` exactly like `DraftingService`/`DocumentsService`;
 * the signer-facing methods (`getForSigner`/`getDocumentForSigner`/`sign`/
 * `decline`) take a bare bearer token instead, because the signer has no
 * Docket session to authenticate with — the same shape as
 * `AuthService.resetPasswordWithToken`, where holding the token already is
 * the proof.
 *
 * **The source lookup is where the non-negotiable review-gate rule (§1)
 * actually gets enforced for this feature**: a `work_product` source must
 * already be `"released"` — never `draft`/`pending_review`/`approved` — so
 * sending something for signature can never become a second way around
 * the attorney checkpoint. A staff-uploaded PDF `document` has no such
 * gate, since it was never agent-drafted content to begin with.
 */
function requireSigningRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`sending something for signature is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

export interface SignerInput {
  name: string;
  email: string;
}

export interface SignerView {
  id: string;
  name: string;
  email: string;
  status: Signer["status"];
  signedAt?: string;
  declinedAt?: string;
  declineReason?: string;
}

export interface EnvelopeSummary {
  id: string;
  matterId: string;
  title: string;
  sourceKind: SignatureEnvelope["sourceKind"];
  sourceId: string;
  status: SignatureEnvelope["status"];
  createdBy: string;
  createdAt: string;
  completedAt?: string;
  voidReason?: string;
  signers: SignerView[];
}

function summarizeSigner(s: Signer): SignerView {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    status: s.status,
    ...(s.signedAt ? { signedAt: s.signedAt } : {}),
    ...(s.declinedAt ? { declinedAt: s.declinedAt } : {}),
    ...(s.declineReason ? { declineReason: s.declineReason } : {}),
  };
}

function summarize(e: SignatureEnvelope): EnvelopeSummary {
  return {
    id: e.id,
    matterId: e.matterId,
    title: e.title,
    sourceKind: e.sourceKind,
    sourceId: e.sourceId,
    status: e.status,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    ...(e.completedAt ? { completedAt: e.completedAt } : {}),
    ...(e.voidReason ? { voidReason: e.voidReason } : {}),
    signers: e.signers.map(summarizeSigner),
  };
}

export interface SignerSigningStatus {
  title: string;
  signerName: string;
  signerStatus: Signer["status"];
  envelopeStatus: SignatureEnvelope["status"];
}

export class ESignatureService {
  #store: ESignatureStore;
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #documents: DocumentStore;
  #workProducts: WorkProductStore;
  #baseUrl: string;
  #email: EmailSender | undefined;
  #firmName: string;

  constructor(params: {
    store: ESignatureStore;
    accessControl: AccessControl;
    auditLog: AuditLog;
    documents: DocumentStore;
    workProducts: WorkProductStore;
    /** Externally reachable base URL the signing link points at (e.g. https://docket.example.com) — no trailing slash. */
    baseUrl: string;
    email?: EmailSender;
    firmName?: string;
  }) {
    this.#store = params.store;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#documents = params.documents;
    this.#workProducts = params.workProducts;
    this.#baseUrl = params.baseUrl;
    this.#email = params.email;
    this.#firmName = params.firmName ?? "Docket";
  }

  /* -------------------------- staff-facing -------------------------- */

  async send(
    actor: Actor,
    params: {
      matterId: string;
      title: string;
      sourceKind: SignatureEnvelope["sourceKind"];
      sourceId: string;
      signers: SignerInput[];
    },
  ): Promise<{ envelope: EnvelopeSummary; signingUrls: Record<string, string>; emailed: boolean }> {
    requireSigningRole(actor);
    this.#accessControl.authorize({ actor, matterId: params.matterId, category: "case_file" });
    if (params.signers.length === 0) throw new EsignatureError("at least one signer is required");
    for (const s of params.signers) {
      if (!s.name.trim()) throw new EsignatureError("every signer needs a name");
      if (s.name.trim().length > MAX_NAME_LENGTH) throw new EsignatureError(`a signer's name must be at most ${MAX_NAME_LENGTH} characters`);
      assertSafeEmailAddress(s.email);
    }

    const { bytes, title } = await this.#resolveSource(params.matterId, params.sourceKind, params.sourceId, params.title);
    const { envelope, tokens } = this.#store.create({
      matterId: params.matterId,
      title,
      sourceKind: params.sourceKind,
      sourceId: params.sourceId,
      documentHash: documentHash(bytes),
      pdfContent: bytes.toString("base64"),
      createdBy: actor.id,
      signers: params.signers,
    });

    const signingUrls: Record<string, string> = {};
    for (const signer of envelope.signers) {
      signingUrls[signer.id] = `${this.#baseUrl}/sign.html?token=${tokens[signer.id]}`;
    }

    // A mail failure here doesn't abort the send — the envelope already
    // exists and staff still has the raw links to deliver by hand, same
    // "degrade, don't fail" reasoning as every other optional-email path
    // in this project (`InvoicingService.emailInvoice` is the one
    // exception, because there the mail *is* the whole point of the call).
    let emailed = false;
    if (this.#email?.canSend) {
      for (const signer of envelope.signers) {
        try {
          await this.#email.send({
            to: signer.email,
            subject: `Please review and sign: ${title}`,
            text: `${signer.name},\n\n${this.#firmName} has sent you a document to review and sign: "${title}".\n\nReview and sign here:\n${signingUrls[signer.id]}\n\nThis link is personal to you and expires in 14 days. If you weren't expecting this, you can ignore this message.`,
          });
          emailed = true;
        } catch {
          // Recorded only by the absence of `emailed` for this signer's
          // row in the response — the signing link itself still works.
        }
      }
    }

    this.#auditLog.append({
      actor,
      matterId: params.matterId,
      action: "esignature_sent",
      detail: `envelope=${envelope.id} title=${title} source=${params.sourceKind}:${params.sourceId} signers=${envelope.signers
        .map((s) => s.email)
        .join(",")}`,
    });
    return { envelope: summarize(envelope), signingUrls, emailed };
  }

  get(actor: Actor, matterId: string, id: string): EnvelopeSummary {
    requireSigningRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return summarize(this.#requireOnMatter(matterId, id));
  }

  listByMatter(actor: Actor, matterId: string): EnvelopeSummary[] {
    requireSigningRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return this.#store.listByMatter(matterId).map(summarize);
  }

  /** Attorney-only, same reasoning as voiding an invoice: a paralegal can prepare and send a request, but withdrawing one already out for signature is supervisory. */
  void(actor: Actor, matterId: string, id: string, reason: string): EnvelopeSummary {
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("voiding a signature request is attorney-only");
    }
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    this.#requireOnMatter(matterId, id);
    if (!reason.trim()) throw new EsignatureError("a reason is required to void a signature request");
    const updated = this.#store.void(id, actor.id, reason.trim());
    this.#auditLog.append({ actor, matterId, action: "esignature_voided", detail: `envelope=${id} reason=${reason.trim()}` });
    return summarize(updated);
  }

  async downloadFinal(actor: Actor, matterId: string, id: string): Promise<{ filename: string; data: Buffer }> {
    requireSigningRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const envelope = this.#requireOnMatter(matterId, id);
    if (envelope.status !== "completed") {
      throw new EsignatureError(`envelope '${id}' is not yet fully signed`);
    }
    if (!envelope.finalPdfContent) {
      throw new EsignatureError(
        `every signer has signed envelope '${id}', but the signed copy with its certificate couldn't be produced — the audit log has the reason`,
      );
    }
    const safe = envelope.title.replace(/[^\w\-. ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return { filename: `${safe || id}.pdf`, data: Buffer.from(envelope.finalPdfContent, "base64") };
  }

  /* ------------------------- signer-facing --------------------------- *
   * No Actor anywhere below — the signer has no Docket session, the same
   * token-is-the-proof shape as AuthService.resetPasswordWithToken.      */

  getForSigner(token: string): SignerSigningStatus {
    const found = this.#store.findSignerByToken(token);
    if (!found) throw new EsignatureError("this signing link is invalid, expired, or has already been used");
    return {
      title: found.envelope.title,
      signerName: found.signer.name,
      signerStatus: found.signer.status,
      envelopeStatus: found.envelope.status,
    };
  }

  getDocumentForSigner(token: string): Buffer {
    const found = this.#store.findSignerByToken(token);
    if (!found) throw new EsignatureError("this signing link is invalid, expired, or has already been used");
    return Buffer.from(found.envelope.pdfContent, "base64");
  }

  async sign(token: string, params: { signatureText: string; ipAddress?: string; userAgent?: string }): Promise<void> {
    const found = this.#store.findSignerByToken(token);
    if (!found) throw new EsignatureError("this signing link is invalid, expired, or has already been used");
    const signatureText = params.signatureText.trim();
    if (!signatureText) throw new EsignatureError("type your name to sign");
    if (signatureText.length > MAX_NAME_LENGTH) {
      throw new EsignatureError(`type your name to sign — at most ${MAX_NAME_LENGTH} characters`);
    }

    const updated = this.#store.recordSignature(found.envelope.id, found.signer.id, {
      signatureText,
      ...(params.ipAddress ? { ipAddress: params.ipAddress } : {}),
      ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    });

    // The signature is recorded, so it is audited now, before anything
    // that could fail. Building the certificate used to come first, and
    // when it threw the signature was on the envelope but in no log.
    const completed = updated.status === "completed";
    this.#auditLog.append({
      actor: { id: found.signer.email, role: "anonymous" },
      matterId: found.envelope.matterId,
      action: "esignature_signed",
      detail: `envelope=${found.envelope.id} signer=${found.signer.id} signedAs=${signatureText}${completed ? " (all signers complete — envelope fully executed)" : ""}`,
    });
    if (!completed) return;

    // A failure here is the firm's to sort out, not the signer's: their
    // signature stands, so they aren't shown an error for it.
    try {
      const final = await stampCertificateOfCompletion(Buffer.from(updated.pdfContent, "base64"), {
        envelopeId: updated.id,
        title: updated.title,
        hash: updated.documentHash,
        signers: updated.signers.map((s) => ({
          name: s.name,
          email: s.email,
          signatureText: s.signatureText,
          signedAt: s.signedAt,
          ipAddress: s.ipAddress,
        })),
      });
      this.#store.setFinalDocument(updated.id, final.toString("base64"));
    } catch (err) {
      this.#auditLog.append({
        actor: { id: found.signer.email, role: "anonymous" },
        matterId: found.envelope.matterId,
        action: "esignature_certificate_failed",
        detail: `envelope=${found.envelope.id} error=${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  decline(token: string, reason: string): void {
    const found = this.#store.findSignerByToken(token);
    if (!found) throw new EsignatureError("this signing link is invalid, expired, or has already been used");
    this.#store.declineBySigner(found.envelope.id, found.signer.id, reason.trim());
    this.#auditLog.append({
      actor: { id: found.signer.email, role: "anonymous" },
      matterId: found.envelope.matterId,
      action: "esignature_declined",
      detail: `envelope=${found.envelope.id} signer=${found.signer.id} reason=${reason.trim()}`,
    });
  }

  /* ------------------------------------------------------------------ */

  async #resolveSource(
    matterId: string,
    sourceKind: SignatureEnvelope["sourceKind"],
    sourceId: string,
    titleOverride: string,
  ): Promise<{ bytes: Buffer; title: string }> {
    if (sourceKind === "document") {
      const doc = this.#documents.get(sourceId);
      if (!doc || doc.matterId !== matterId) throw new EsignatureError(`no document '${sourceId}' on matter '${matterId}'`);
      if (doc.contentType !== "application/pdf") {
        throw new EsignatureError(`'${doc.fileName}' is not a PDF — only a PDF document can be sent for signature`);
      }
      const bytes = Buffer.from(doc.content, "base64");
      if (!(await canStampPdf(bytes))) {
        throw new EsignatureError(
          `'${doc.fileName}' couldn't be opened as a PDF — it may be damaged or password-protected. Save an unprotected copy and upload that.`,
        );
      }
      return { bytes, title: titleOverride.trim() || doc.fileName };
    }
    const wp = this.#workProducts.get(sourceId);
    if (!wp || wp.matterId !== matterId) throw new EsignatureError(`no draft '${sourceId}' on matter '${matterId}'`);
    if (wp.status !== "released") {
      throw new EsignatureError(
        `draft '${sourceId}' must be released by an attorney before it can be sent for signature (status is '${wp.status}')`,
      );
    }
    const title = titleOverride.trim() || `${wp.kind} — ${matterId}`;
    return { bytes: await renderPlainTextPdf(title, wp.content), title };
  }

  #requireOnMatter(matterId: string, id: string): SignatureEnvelope {
    const envelope = this.#store.get(id);
    if (!envelope || envelope.matterId !== matterId) {
      throw new EsignatureError(`no signature envelope '${id}' on matter '${matterId}'`);
    }
    return envelope;
  }
}
