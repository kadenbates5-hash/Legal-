import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { MatterStore, Matter } from "../core/matters.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { DocumentStore, CaseDocument } from "../core/document-store.js";
import type { ResearchLibrary, SavedReference } from "../core/research-library.js";
import type { BillingHoursStore, BillingHoursEntry } from "../core/billing-hours.js";
import type { TrustLedger, TrustEntry } from "../core/trust-ledger.js";

/**
 * Exports everything the firm holds for one matter as a single bundle.
 *
 * This exists because **the client file belongs to the client.** A
 * client who changes firms is entitled to their file, and a firm that
 * can only produce it by manually trawling six different systems tends
 * to produce it late and incomplete. Portability is an ethical duty, not
 * a convenience feature — so it's a first-class operation with an audit
 * trail rather than an afterthought.
 *
 * Two deliberate choices:
 *
 * - **Attorney-only.** Handing over a client file is a disclosure
 *   decision with privilege implications (what's included, what's firm
 *   work product, whether a lien applies). That's a supervisory call,
 *   not a bookkeeping one.
 * - **Every export is audited**, with a count of what left. If a file
 *   was produced, the firm should be able to show when and by whom.
 *
 * What it deliberately does *not* do: decide what a client is legally
 * entitled to. Jurisdictions differ on whether internal firm work
 * product and unbilled drafts form part of the client file, and a
 * retaining lien may apply. The bundle marks the categories so an
 * attorney can withhold rather than pretending the question is settled —
 * see `ClientFileExport.notice`.
 */
export interface ClientFileExport {
  matterId: string;
  exportedAt: string;
  exportedBy: string;
  /** Read this before handing the bundle over — see the class doc comment. */
  notice: string;
  matter: Matter | undefined;
  workProducts: {
    id: string;
    kind: string;
    status: string;
    flags: string[];
    content: string;
  }[];
  documents: CaseDocument[];
  researchReferences: SavedReference[];
  billingHours: BillingHoursEntry[];
  trustLedger: { entries: TrustEntry[]; balanceCents: number };
  counts: Record<string, number>;
}

const EXPORT_NOTICE =
  "This bundle contains everything Docket holds for this matter, including internal firm work product and drafts " +
  "that were never released to the client. Whether those form part of the client's file — and whether a retaining " +
  "lien applies — varies by jurisdiction. Review and withhold before producing this to anyone.";

export class ClientFileService {
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #matters: MatterStore;
  #workProducts: WorkProductStore;
  #documents: DocumentStore;
  #research: ResearchLibrary;
  #billing: BillingHoursStore;
  #trust: TrustLedger;

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    matters: MatterStore;
    workProducts: WorkProductStore;
    documents: DocumentStore;
    research: ResearchLibrary;
    billing: BillingHoursStore;
    trust: TrustLedger;
  }) {
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#matters = params.matters;
    this.#workProducts = params.workProducts;
    this.#documents = params.documents;
    this.#research = params.research;
    this.#billing = params.billing;
    this.#trust = params.trust;
  }

  export(actor: Actor, matterId: string): ClientFileExport {
    if (actor.role !== "attorney") {
      throw new AccessDeniedError(`exporting a client file is attorney-only (got role '${actor.role}')`);
    }
    // Belt and braces: an attorney passes AccessControl for any matter, but
    // routing the export through the same gate as every other read keeps a
    // single place where matter access is decided.
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });

    const workProducts = this.#workProducts.listByMatter(matterId).map((wp) => ({
      id: wp.id,
      kind: wp.kind,
      status: wp.status,
      flags: [...wp.flags],
      content: wp.content,
    }));
    const documents = this.#documents.listByMatter(matterId);
    const researchReferences = this.#research.listByMatter(matterId);
    const billingHours = this.#billing.listByMatter(matterId);
    const trustEntries = this.#trust.listForMatter(matterId);

    const counts = {
      workProducts: workProducts.length,
      documents: documents.length,
      researchReferences: researchReferences.length,
      billingHours: billingHours.length,
      trustEntries: trustEntries.length,
    };

    this.#auditLog.append({
      actor,
      matterId,
      action: "client_file_exported",
      detail: Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    });

    return {
      matterId,
      exportedAt: new Date().toISOString(),
      exportedBy: actor.id,
      notice: EXPORT_NOTICE,
      matter: this.#matters.get(matterId),
      workProducts,
      documents,
      researchReferences,
      billingHours,
      trustLedger: { entries: trustEntries, balanceCents: this.#trust.balanceForMatter(matterId) },
      counts,
    };
  }
}
