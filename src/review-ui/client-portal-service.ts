import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { Matter, MatterStatus, MatterStore } from "../core/matters.js";
import type { CaseDocument, DocumentStore } from "../core/document-store.js";
import type { TrustLedger } from "../core/trust-ledger.js";
import type { InvoicingService, InvoiceView } from "./invoicing-service.js";
import type { RenderedInvoice } from "../core/invoice-render.js";

/**
 * Backs Docket's client-facing "My Matters" surface — the one part of
 * this system a client logs into directly rather than only ever
 * receiving email from.
 *
 * **The whole design constraint is that this is a narrower view than
 * anything staff sees, not the same data with a different login.** A
 * matter record's `parties` names the adverse side; `case_file` reaches
 * privileged drafts and internal notes; `billing_internal` reaches every
 * timekeeper's rate. None of that is safe to hand a client, so this
 * service does not reuse those categories at all — it is gated entirely
 * through `AccessControl`'s `client_portal` category, and every method
 * here builds its own hand-picked, client-safe projection rather than
 * passing an internal record through:
 *
 *  - a matter is `{ matterId, title, status }` — never `description` or
 *    `parties`;
 *  - a document only appears if a paralegal/attorney explicitly marked
 *    it `visibleToClient` (see `DocumentsService.setClientVisibility`) —
 *    an upload defaults to private, the same as a draft starting
 *    unreviewed;
 *  - an invoice is exactly what `InvoicingService.emailInvoice` already
 *    sent to this client's inbox (`listForClient`/`previewForClient`/
 *    `renderPdfForClient`), never a draft — a client seeing a
 *    paralegal's in-progress guess before an attorney commits it is the
 *    same "not final" leak the review gate exists to prevent everywhere
 *    else in this system;
 *  - the trust balance is a single number (`TrustLedger.balanceForMatter`),
 *    never the entry history, which can carry narrative descriptions of
 *    firm work that go beyond what a balance needs to say.
 *
 * There is deliberately no online payment here. `ManualPaymentProcessor`
 * is the only processor this project wires up (see
 * `integrations/payment-processor.ts`) — nothing has ever accepted a
 * live card in this system, for any role — so a "Pay now" button would
 * be a promise the software can't keep. `getMatter()` instead surfaces
 * the firm's payment instructions text so the portal can say how to pay
 * honestly, the same "say what's actually configured" pattern
 * `emailTransportReady()` already uses for the Invoices panel.
 *
 * There is also no messaging here yet — `core/messaging.ts` is a
 * staff-only directory-backed system, and a client is deliberately not
 * in that directory (see `StaffService`). A client-firm message thread
 * would be a reasonable next addition but is a distinct feature, not a
 * gap in this one.
 */
export interface ClientMatterSummary {
  matterId: string;
  title: string;
  status: MatterStatus;
}

export interface ClientDocumentSummary {
  id: string;
  matterId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}

export interface ClientMatterDetail extends ClientMatterSummary {
  /** Present only when a `TrustLedger` is configured. */
  trustBalanceCents?: number;
  /** Present only when `InvoicingService` is configured; otherwise the portal has nothing to show for billing. */
  invoices?: InvoiceView[];
  documents: ClientDocumentSummary[];
  /** From `FirmConfig.letterhead.paymentInstructions` — how to actually pay, since this system cannot take a card itself. */
  paymentInstructions: string | undefined;
}

function requireClient(actor: Actor): void {
  if (actor.role !== "client") {
    throw new AccessDeniedError(`the client portal is client-only (got role '${actor.role}')`);
  }
}

function summarizeDocument(doc: CaseDocument): ClientDocumentSummary {
  return {
    id: doc.id,
    matterId: doc.matterId,
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedAt: doc.uploadedAt,
  };
}

export class ClientPortalService {
  #accessControl: AccessControl;
  #matters: MatterStore;
  #documents: DocumentStore;
  #trust: TrustLedger | undefined;
  #invoicing: InvoicingService | undefined;
  #paymentInstructions: string | undefined;

  constructor(params: {
    accessControl: AccessControl;
    matters: MatterStore;
    documents: DocumentStore;
    /** Absent means the portal shows no trust balance card. */
    trust?: TrustLedger;
    /** Absent means the portal shows no invoices at all — same "absent config degrades, never gates" pattern as the rest of this project's optional integrations. */
    invoicing?: InvoicingService;
    paymentInstructions?: string;
  }) {
    this.#accessControl = params.accessControl;
    this.#matters = params.matters;
    this.#documents = params.documents;
    this.#trust = params.trust;
    this.#invoicing = params.invoicing;
    this.#paymentInstructions = params.paymentInstructions;
  }

  /**
   * Every matter this client account has been granted. Doesn't call
   * `authorize()` per matter — `AccessControl.getClientMatterIds` *is*
   * the authorization here, the same relationship `CasesService.listCases`
   * has to `getCase`'s per-matter check. A grant naming a matterId with
   * no `Matter` record yet (an attorney granted access before filling
   * in the record) is silently omitted rather than shown half-blank.
   */
  listMyMatters(actor: Actor): ClientMatterSummary[] {
    requireClient(actor);
    const matters: Matter[] = [];
    for (const matterId of this.#accessControl.getClientMatterIds(actor.id)) {
      const matter = this.#matters.get(matterId);
      if (matter) matters.push(matter);
    }
    return matters
      .map((m) => ({ matterId: m.matterId, title: m.title, status: m.status }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  getMatter(actor: Actor, matterId: string): ClientMatterDetail {
    requireClient(actor);
    this.#accessControl.authorize({ actor, matterId, category: "client_portal" });
    const matter = this.#matters.get(matterId);
    if (!matter) throw new Error(`no matter '${matterId}'`);
    return {
      matterId: matter.matterId,
      title: matter.title,
      status: matter.status,
      ...(this.#trust ? { trustBalanceCents: this.#trust.balanceForMatter(matterId) } : {}),
      ...(this.#invoicing ? { invoices: this.#invoicing.listForClient(actor, matterId) } : {}),
      documents: this.#documents
        .listByMatter(matterId)
        .filter((doc) => doc.visibleToClient)
        .map(summarizeDocument),
      paymentInstructions: this.#paymentInstructions,
    };
  }

  previewInvoice(actor: Actor, matterId: string, invoiceId: string): RenderedInvoice {
    requireClient(actor);
    if (!this.#invoicing) throw new Error("invoicing is not configured on this server");
    return this.#invoicing.previewForClient(actor, matterId, invoiceId);
  }

  async invoicePdf(actor: Actor, matterId: string, invoiceId: string): Promise<{ filename: string; data: Buffer }> {
    requireClient(actor);
    if (!this.#invoicing) throw new Error("invoicing is not configured on this server");
    return this.#invoicing.renderPdfForClient(actor, matterId, invoiceId);
  }

  /** Includes base64 content, for download. Refuses a document that exists but was never shared — same denial either way as one that doesn't exist, so a client can't distinguish "not shared" from "made up". */
  getDocument(actor: Actor, matterId: string, documentId: string): CaseDocument {
    requireClient(actor);
    this.#accessControl.authorize({ actor, matterId, category: "client_portal" });
    const doc = this.#documents.get(documentId);
    if (!doc || doc.matterId !== matterId || !doc.visibleToClient) {
      throw new Error(`no document '${documentId}' on matter '${matterId}'`);
    }
    return doc;
  }
}
