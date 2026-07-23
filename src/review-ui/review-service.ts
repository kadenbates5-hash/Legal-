import { AccessDeniedError, type Actor } from "../core/types.js";
import type { WorkProduct, WorkProductStatus } from "../core/review-gate.js";
import type { WorkProductStore } from "../core/work-product-store.js";

/**
 * Application layer behind the attorney review-gate UI (§8 build order
 * step 5). `review-gate.ts` already guards the status-transition methods
 * (`approve`/`release`/etc. throw for a non-attorney actor), but reading
 * and listing work product is unguarded at that layer since it's meant to
 * be usable by the drafting agents that create it. This service is the
 * attorney-facing surface specifically, so every method here — including
 * plain reads — requires an attorney actor. A receptionist or paralegal
 * credential should never reach this API at all, not just be blocked on
 * the mutating calls.
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

function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`review-gate UI is attorney-only (got role '${actor.role}')`);
  }
}

function summarize(wp: WorkProduct): WorkProductSummary {
  return { id: wp.id, matterId: wp.matterId, kind: wp.kind, status: wp.status, flags: [...wp.flags] };
}

function detail(wp: WorkProduct): WorkProductDetail {
  return { ...summarize(wp), content: wp.content, history: wp.history };
}

export class ReviewGateService {
  #store: WorkProductStore;

  constructor(store: WorkProductStore) {
    this.#store = store;
  }

  listPendingReview(actor: Actor): WorkProductSummary[] {
    requireAttorney(actor);
    return this.#store.listByStatus("pending_review").map(summarize);
  }

  listAll(actor: Actor): WorkProductSummary[] {
    requireAttorney(actor);
    return this.#store.listAll().map(summarize);
  }

  get(actor: Actor, id: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    return detail(wp);
  }

  approve(actor: Actor, id: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    wp.approve(actor);
    return detail(wp);
  }

  reject(actor: Actor, id: string, reason: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    wp.reject(actor, reason);
    return detail(wp);
  }

  requestRevision(actor: Actor, id: string, note: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    wp.requestRevision(actor, note);
    return detail(wp);
  }

  release(actor: Actor, id: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    wp.release(actor);
    return detail(wp);
  }

  clearFlag(actor: Actor, id: string, flag: string): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);
    wp.clearFlag(actor, flag);
    return detail(wp);
  }

  #requireWorkProduct(id: string): WorkProduct {
    const wp = this.#store.get(id);
    if (!wp) {
      throw new Error(`no work product '${id}'`);
    }
    return wp;
  }
}
