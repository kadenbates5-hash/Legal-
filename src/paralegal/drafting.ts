import { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import { WorkProduct } from "../core/review-gate.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
import type { UtilizationTracker } from "../core/utilization.js";

/**
 * Paralegal agent drafting functions (§3, §8 build order step 4). This is
 * the practice-area-agnostic drafting engine — it owns no legal-content
 * knowledge itself, only the hard-coded behaviors §3 requires of every
 * practice area:
 *
 *  - every draft is access-controlled via `AccessControl` before creation
 *  - every draft is a `WorkProduct`, so nothing it produces can leave the
 *    system without the review-gate's attorney checkpoint
 *  - legal research summaries always carry a mandatory attorney-
 *    verification flag — not module-configurable, not optional
 *  - deadline-referencing drafts always carry a mandatory redundant-
 *    verification flag, since §3 calls agent-calculated deadlines "the top
 *    malpractice risk in criminal defense" (§7 open item #1 is the full
 *    calendar-redundancy system; this is the enforced stopgap until that
 *    exists — an attorney must clear it before approval either way)
 *  - practice-area-specific hard triggers (e.g. Padilla) are still applied,
 *    via `PracticeAreaModule.deriveWorkProductFlags`
 */
export const RESEARCH_REQUIRES_VERIFICATION_FLAG = "research_requires_attorney_verification";
export const DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG = "deadline_requires_redundant_verification";

export interface DraftFromTemplateRequest {
  templateId: string;
  content: string;
  /** Passed through to the module's deriveWorkProductFlags (e.g. { clientIsNoncitizen: true }). */
  context?: Record<string, unknown>;
  /** If this draft references a calculated deadline, it's flagged for redundant verification. */
  deadlineDate?: string;
}

export interface ResearchSummaryRequest {
  content: string;
  citations: string[];
}

export interface BillingNarrativeRequest {
  content: string;
}

let workProductSequence = 0;
function nextWorkProductId(kind: string): string {
  workProductSequence += 1;
  return `wp_${kind}_${workProductSequence}`;
}

export class ParalegalDraftingSession {
  #actor: Actor;
  #matterId: string;
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #module: PracticeAreaModule;
  #utilization: UtilizationTracker | undefined;
  #store: WorkProductStore | undefined;
  #utilizationEntryByWorkProduct = new Map<string, string>();

  constructor(params: {
    actor: Actor;
    matterId: string;
    accessControl: AccessControl;
    auditLog: AuditLog;
    module: PracticeAreaModule;
    utilization?: UtilizationTracker;
    store?: WorkProductStore;
  }) {
    this.#actor = params.actor;
    this.#matterId = params.matterId;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#module = params.module;
    this.#utilization = params.utilization;
    this.#store = params.store;
  }

  /** §3: "Draft from templates: engagement letters, discovery requests, correspondence, motions." */
  draftFromTemplate(request: DraftFromTemplateRequest): WorkProduct {
    const template = this.#module.templates.find((t) => t.id === request.templateId);
    if (!template) {
      throw new Error(`unknown document template '${request.templateId}' for module '${this.#module.id}'`);
    }

    const workProduct = this.#startDraft(request.templateId, request.content, `draft ${template.name}`);

    const flags = [
      ...template.requiredFlags,
      ...this.#module.deriveWorkProductFlags(request.templateId, request.context ?? {}),
    ];
    for (const flag of flags) workProduct.addFlag(flag);

    if (request.deadlineDate !== undefined) {
      workProduct.addFlag(DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG);
    }

    return workProduct;
  }

  /**
   * §3: "Legal research summaries, with citations, explicitly flagged as
   * needing attorney verification." Unlike template drafts, this flag is
   * unconditional — there is no context under which a research summary
   * skips it.
   */
  draftResearchSummary(request: ResearchSummaryRequest): WorkProduct {
    if (request.citations.length === 0) {
      throw new Error("a research summary must include at least one citation");
    }
    const content = `${request.content}\n\nCitations:\n${request.citations.map((c) => `- ${c}`).join("\n")}`;
    const workProduct = this.#startDraft("research_summary", content, "draft legal research summary");
    workProduct.addFlag(RESEARCH_REQUIRES_VERIFICATION_FLAG);
    return workProduct;
  }

  /**
   * §3/§4: billing/time-entry narrative drafts — internal only, but still a
   * `WorkProduct` since a narrative that reaches an invoice is exactly the
   * case §1's non-negotiable rule names explicitly. Access-scoped to
   * `billing_internal` rather than `case_file`.
   */
  draftBillingNarrative(request: BillingNarrativeRequest): WorkProduct {
    return this.#startDraft("billing_narrative", request.content, "draft billing narrative", "billing_internal");
  }

  /** Marks the paralegal's part of a draft done and submits it into the review gate. */
  submitForReview(workProduct: WorkProduct): void {
    workProduct.submitForReview(this.#actor);
    const utilizationEntryId = this.#utilizationEntryByWorkProduct.get(workProduct.id);
    if (this.#utilization && utilizationEntryId) {
      this.#utilization.finish(utilizationEntryId, "completed");
    }
  }

  /** Revise a draft still in `draft`/`revision_requested` — throws otherwise (see review-gate.ts). */
  reviseDraft(workProduct: WorkProduct, newContent: string): void {
    workProduct.reviseDraft(this.#actor, newContent);
  }

  #startDraft(
    kind: string,
    content: string,
    utilizationDescription: string,
    category: "case_file" | "billing_internal" = "case_file",
  ): WorkProduct {
    this.#accessControl.authorize({ actor: this.#actor, matterId: this.#matterId, category });

    const utilizationEntryId = this.#utilization?.start({
      matterId: this.#matterId,
      agentRole: "paralegal",
      taskType: category === "billing_internal" ? "other" : "drafting",
      description: utilizationDescription,
    }).id;

    const workProduct = new WorkProduct(
      { id: nextWorkProductId(kind), matterId: this.#matterId, kind, content },
      this.#auditLog,
    );

    if (utilizationEntryId) {
      this.#utilizationEntryByWorkProduct.set(workProduct.id, utilizationEntryId);
    }

    this.#store?.register(workProduct);

    return workProduct;
  }
}
