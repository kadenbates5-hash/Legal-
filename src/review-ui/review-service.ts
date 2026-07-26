import { AccessDeniedError, ReviewGateError, type Actor } from "../core/types.js";
import type { WorkProduct, WorkProductStatus } from "../core/review-gate.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import {
  DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG,
  type DeadlineConflict,
  type DeadlineStatus,
  type DeadlineTracker,
  type UpcomingDeadline,
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

/** Two weeks: far enough to act on a court date, close enough that the list stays short enough to read. */
export const DEFAULT_DEADLINE_HORIZON_DAYS = 14;

/**
 * Higher is more urgent. Time pressure dominates, but an unverified date
 * carries its own weight that grows as the date approaches — because the
 * window in which the verification could still change anything is what's
 * actually closing.
 */
function deadlineUrgency(deadline: UpcomingDeadline): number {
  // 0 days away scores 100, 14 days away scores ~0; already overdue
  // scores above 100 and keeps climbing.
  const timePressure = 100 - deadline.daysAway * 7;
  const verificationRisk =
    deadline.confirmationState === "conflict" ? 60 : deadline.confirmationState === "unconfirmed" ? 40 : 0;
  return timePressure + verificationRisk;
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

  /**
   * Records an independent (human or calendar-system) deadline calculation
   * — never "agent". The source and the actor's role must match: a
   * `calendar_system` confirmation must come from the calendar
   * integration's own credential (role `"system"`, authenticated via
   * `AuthService.verifySystemApiKey` — see `review-ui/server.ts`), not
   * from an attorney who merely picked "calendar_system" in a dropdown.
   * Without this, "two independent sources" in `core/deadline.ts` would be
   * enforceable in name only — any human could self-report as the second,
   * supposedly-independent source.
   */
  confirmDeadline(actor: Actor, matterId: string, type: DeadlineType, date: string, source: "human" | "calendar_system"): DeadlineStatus {
    if (source === "calendar_system") {
      if (actor.role !== "system") {
        throw new AccessDeniedError(
          "a 'calendar_system' confirmation requires the calendar integration's own credential, not a human actor",
        );
      }
    } else {
      requireAttorney(actor);
    }
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

  /**
   * What is coming due, with the risk ranking that makes the list worth
   * looking at.
   *
   * Sorted by **urgency, not date**. A deadline eight days out that two
   * sources disagree about, or that only one source has ever seen, is a
   * worse position to be in than a confirmed deadline tomorrow: the
   * confirmed one is a task, the unconfirmed one is a question nobody
   * has asked yet, and the time left to ask it is running out. Ranking
   * purely by date would bury exactly the rows that need attention.
   *
   * `today` is a parameter so a caller can pass the firm's own local
   * date rather than the server's — same reasoning as the time clock.
   */
  listUpcomingDeadlines(
    actor: Actor,
    options: { withinDays?: number; today?: string } = {},
  ): (UpcomingDeadline & { urgency: number })[] {
    requireAttorney(actor);
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    const withinDays = options.withinDays ?? DEFAULT_DEADLINE_HORIZON_DAYS;
    const upcoming = this.#deadlineTracker?.listUpcoming({ today, withinDays }) ?? [];

    return upcoming
      .map((d) => ({ ...d, urgency: deadlineUrgency(d) }))
      .sort((a, b) => b.urgency - a.urgency || a.date.localeCompare(b.date));
  }

  #requireWorkProduct(id: string): WorkProduct {
    const wp = this.#store.get(id);
    if (!wp) {
      throw new Error(`no work product '${id}'`);
    }
    return wp;
  }
}
