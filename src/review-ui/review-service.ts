import { AccessDeniedError, ReviewGateError, type Actor } from "../core/types.js";
import type { WorkProduct, WorkProductStatus } from "../core/review-gate.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import {
  DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG,
  type DeadlineConflict,
  type DeadlineStatus,
  type DeadlineTracker,
  type DeadlineType,
} from "../core/deadline.js";

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
  #deadlineTracker: DeadlineTracker | undefined;

  constructor(store: WorkProductStore, deadlineTracker?: DeadlineTracker) {
    this.#store = store;
    this.#deadlineTracker = deadlineTracker;
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

  /**
   * Clearing the deadline-redundancy flag specifically requires the
   * deadline to actually be `"confirmed"` by the tracker (two independent
   * sources agreeing) — an attorney can't just wave it through the way
   * they can any other flag, because that flag exists to enforce §3's
   * "never single-sourced" rule, not just to prompt a second look.
   */
  clearFlag(actor: Actor, id: string, flag: string, deadlineType?: DeadlineType): WorkProductDetail {
    requireAttorney(actor);
    const wp = this.#requireWorkProduct(id);

    if (flag === DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG) {
      if (!deadlineType) {
        throw new ReviewGateError("clearing the deadline flag requires specifying which deadlineType it confirms");
      }
      if (!this.#deadlineTracker?.isConfirmed(wp.matterId, deadlineType)) {
        throw new ReviewGateError(
          `cannot clear '${flag}': deadline '${deadlineType}' for matter '${wp.matterId}' is not yet confirmed by two independent sources`,
        );
      }
    }

    wp.clearFlag(actor, flag);
    return detail(wp);
  }

  /** Records an independent (human or calendar-system) deadline calculation — never "agent". */
  confirmDeadline(actor: Actor, matterId: string, type: DeadlineType, date: string, source: "human" | "calendar_system"): DeadlineStatus {
    requireAttorney(actor);
    if (!this.#deadlineTracker) {
      throw new Error("no deadline tracker configured");
    }
    return this.#deadlineTracker.record({ matterId, type, date, source, note: `confirmed by ${actor.id}` });
  }

  getDeadlineStatus(actor: Actor, matterId: string, type: DeadlineType): DeadlineStatus {
    requireAttorney(actor);
    return this.#deadlineTracker?.status(matterId, type) ?? { state: "unconfirmed", calculations: [] };
  }

  listDeadlineConflicts(actor: Actor): DeadlineConflict[] {
    requireAttorney(actor);
    return this.#deadlineTracker?.listConflicts() ?? [];
  }

  #requireWorkProduct(id: string): WorkProduct {
    const wp = this.#store.get(id);
    if (!wp) {
      throw new Error(`no work product '${id}'`);
    }
    return wp;
  }
}
