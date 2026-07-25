import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { WorkProduct, WorkProductStatus } from "../core/review-gate.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { DeadlineTracker } from "../core/deadline.js";
import type { PracticeAreaModule, DocumentTemplate } from "../config/practice-area.js";
import type { UtilizationTracker } from "../core/utilization.js";
import {
  ParalegalDraftingSession,
  type DraftFromTemplateRequest,
  type ResearchSummaryRequest,
  type BillingNarrativeRequest,
} from "../paralegal/drafting.js";

/**
 * The paralegal-facing surface backing Docket's "Drafting" panel — where
 * a paralegal (or an attorney, who can do anything a paralegal can) writes
 * up contracts, motions, discovery requests, research summaries, and
 * billing narratives, then submits them into the review queue.
 *
 * `paralegal/drafting.ts`'s `ParalegalDraftingSession` already enforces
 * access control on *creating* a draft, but its `reviseDraft`/
 * `submitForReview` take a `WorkProduct` object reference directly — safe
 * in-process (you can only hold a reference you were already handed), but
 * not safe once exposed over HTTP by id, where any authenticated caller
 * could name an arbitrary work-product id. This service adds that missing
 * check itself before ever touching drafting-session methods.
 *
 * A `ParalegalDraftingSession` is cached per (actor, matter) pair and
 * reused across requests — not just for efficiency: the session's internal
 * utilization-entry bookkeeping (start on create, finish on submit) only
 * works if the same instance sees both calls, and those two calls
 * naturally land in separate HTTP requests.
 */
export interface WorkProductSummary {
  id: string;
  matterId: string;
  kind: string;
  status: WorkProductStatus;
  flags: string[];
}

export interface WorkProductDetail extends WorkProductSummary {
  content: string;
  history: WorkProduct["history"];
}

function requireDraftingRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`drafting is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

function summarize(wp: WorkProduct): WorkProductSummary {
  return { id: wp.id, matterId: wp.matterId, kind: wp.kind, status: wp.status, flags: [...wp.flags] };
}

function detail(wp: WorkProduct): WorkProductDetail {
  return { ...summarize(wp), content: wp.content, history: wp.history };
}

export class DraftingService {
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #module: PracticeAreaModule;
  #store: WorkProductStore;
  #utilization: UtilizationTracker | undefined;
  #deadlineTracker: DeadlineTracker | undefined;
  #sessions = new Map<string, ParalegalDraftingSession>();

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    module: PracticeAreaModule;
    store: WorkProductStore;
    utilization?: UtilizationTracker;
    deadlineTracker?: DeadlineTracker;
  }) {
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#module = params.module;
    this.#store = params.store;
    this.#utilization = params.utilization;
    this.#deadlineTracker = params.deadlineTracker;
  }

  /** The practice area's available templates — not itself matter- or access-scoped, just the module's static catalog. */
  listTemplates(actor: Actor): DocumentTemplate[] {
    requireDraftingRole(actor);
    return this.#module.templates;
  }

  listMatterWorkProduct(actor: Actor, matterId: string): WorkProductSummary[] {
    requireDraftingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return this.#store.listByMatter(matterId).map(summarize);
  }

  get(actor: Actor, matterId: string, id: string): WorkProductDetail {
    requireDraftingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return detail(this.#requireMatterWorkProduct(matterId, id));
  }

  draftFromTemplate(actor: Actor, matterId: string, request: DraftFromTemplateRequest): WorkProductDetail {
    requireDraftingRole(actor);
    const wp = this.#sessionFor(actor, matterId).draftFromTemplate(request);
    return detail(wp);
  }

  draftResearchSummary(actor: Actor, matterId: string, request: ResearchSummaryRequest): WorkProductDetail {
    requireDraftingRole(actor);
    const wp = this.#sessionFor(actor, matterId).draftResearchSummary(request);
    return detail(wp);
  }

  draftBillingNarrative(actor: Actor, matterId: string, request: BillingNarrativeRequest): WorkProductDetail {
    requireDraftingRole(actor);
    const wp = this.#sessionFor(actor, matterId).draftBillingNarrative(request);
    return detail(wp);
  }

  reviseDraft(actor: Actor, matterId: string, id: string, newContent: string): WorkProductDetail {
    requireDraftingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const wp = this.#requireMatterWorkProduct(matterId, id);
    this.#sessionFor(actor, matterId).reviseDraft(wp, newContent);
    return detail(wp);
  }

  submitForReview(actor: Actor, matterId: string, id: string): WorkProductDetail {
    requireDraftingRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const wp = this.#requireMatterWorkProduct(matterId, id);
    this.#sessionFor(actor, matterId).submitForReview(wp);
    return detail(wp);
  }

  #requireMatterWorkProduct(matterId: string, id: string): WorkProduct {
    const wp = this.#store.get(id);
    if (!wp || wp.matterId !== matterId) {
      throw new Error(`no work product '${id}' on matter '${matterId}'`);
    }
    return wp;
  }

  #sessionFor(actor: Actor, matterId: string): ParalegalDraftingSession {
    const key = `${actor.id}:${matterId}`;
    let session = this.#sessions.get(key);
    if (!session) {
      session = new ParalegalDraftingSession({
        actor,
        matterId,
        accessControl: this.#accessControl,
        auditLog: this.#auditLog,
        module: this.#module,
        store: this.#store,
        ...(this.#utilization ? { utilization: this.#utilization } : {}),
        ...(this.#deadlineTracker ? { deadlineTracker: this.#deadlineTracker } : {}),
      });
      this.#sessions.set(key, session);
    }
    return session;
  }
}
