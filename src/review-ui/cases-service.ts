import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { WorkProduct } from "../core/review-gate.js";
import type { CaseDocument } from "../core/document-store.js";
import type { DocumentStore } from "../core/document-store.js";
import type { WorkProductSummary } from "./drafting-service.js";
import type { DocumentSummary } from "./documents-service.js";

/**
 * Backs Docket's "Cases" panel: a clickable list of matters (there's no
 * separate `Matter` entity anywhere in this system — a matter is just the
 * `matterId` string that `WorkProductStore`, `DocumentStore`, and
 * `AccessControl`'s paralegal assignments all key on), each expanding to
 * everything on file for it — drafted work product plus uploaded
 * documents. Read-only aggregation over the same access-controlled stores
 * `DraftingService`/`DocumentsService` already guard; this adds no new
 * write paths of its own.
 */
export interface CaseSummary {
  matterId: string;
  workProductCount: number;
  documentCount: number;
}

export interface CaseDetail extends CaseSummary {
  workProducts: WorkProductSummary[];
  documents: DocumentSummary[];
}

function requireCaseFileRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`case listing is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

function summarizeWorkProduct(wp: WorkProduct): WorkProductSummary {
  return { id: wp.id, matterId: wp.matterId, kind: wp.kind, status: wp.status, flags: [...wp.flags] };
}

function summarizeDocument(doc: CaseDocument): DocumentSummary {
  return {
    id: doc.id,
    matterId: doc.matterId,
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
  };
}

export class CasesService {
  #accessControl: AccessControl;
  #workProductStore: WorkProductStore;
  #documentStore: DocumentStore;

  constructor(params: { accessControl: AccessControl; workProductStore: WorkProductStore; documentStore: DocumentStore }) {
    this.#accessControl = params.accessControl;
    this.#workProductStore = params.workProductStore;
    this.#documentStore = params.documentStore;
  }

  listCases(actor: Actor): CaseSummary[] {
    requireCaseFileRole(actor);
    return this.#visibleMatterIds(actor).map((matterId) => this.#summarize(matterId));
  }

  getCase(actor: Actor, matterId: string): CaseDetail {
    requireCaseFileRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return {
      ...this.#summarize(matterId),
      workProducts: this.#workProductStore.listByMatter(matterId).map(summarizeWorkProduct),
      documents: this.#documentStore.listByMatter(matterId).map(summarizeDocument),
    };
  }

  #summarize(matterId: string): CaseSummary {
    return {
      matterId,
      workProductCount: this.#workProductStore.listByMatter(matterId).length,
      documentCount: this.#documentStore.listByMatter(matterId).length,
    };
  }

  /** Every matterId this system knows about (from drafts, documents, or a paralegal assignment), filtered to what this actor can see. */
  #visibleMatterIds(actor: Actor): string[] {
    const all = new Set<string>();
    for (const wp of this.#workProductStore.listAll()) all.add(wp.matterId);
    for (const doc of this.#documentStore.listAll()) all.add(doc.matterId);
    for (const assignment of this.#accessControl.listAssignments()) all.add(assignment.matterId);

    if (actor.role === "attorney") return [...all];

    return [...all].filter((matterId) => {
      try {
        this.#accessControl.authorize({ actor, matterId, category: "case_file" });
        return true;
      } catch {
        return false;
      }
    });
  }
}
