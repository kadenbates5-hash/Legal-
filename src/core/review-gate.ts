import { ReviewGateError, type Actor } from "./types.js";
import type { AuditLog } from "./audit.js";

/**
 * §1 non-negotiable rule: "nothing produced by either agent reaches a
 * client, a filing, or an invoice without passing through a human attorney
 * checkpoint. The agents draft and triage; they do not finalize."
 *
 * This is implemented as an actual state machine with a guarded terminal
 * transition (`release`), not as a prompt instruction — see §8's build note
 * to keep review gates as enforced code paths.
 *
 * `flags` generalizes hard-trigger requirements like the Padilla
 * immigration-consequence advisory (§3): a practice-area module can attach
 * a flag that blocks approval until an attorney explicitly clears it.
 */
export type WorkProductStatus =
  | "draft"
  | "pending_review"
  | "revision_requested"
  | "approved"
  | "released"
  | "rejected";

export interface WorkProductTransition {
  from: WorkProductStatus;
  to: WorkProductStatus;
  actor: Actor;
  timestamp: string;
  note: string | undefined;
}

export class WorkProduct {
  readonly id: string;
  readonly matterId: string;
  readonly kind: string;
  status: WorkProductStatus = "draft";
  content: string;
  readonly flags = new Set<string>();
  readonly history: WorkProductTransition[] = [];

  #auditLog: AuditLog;

  constructor(params: { id: string; matterId: string; kind: string; content: string }, auditLog: AuditLog) {
    this.id = params.id;
    this.matterId = params.matterId;
    this.kind = params.kind;
    this.content = params.content;
    this.#auditLog = auditLog;
  }

  /** A practice-area module hard-triggers a flag (e.g. "padilla_advisory_required"). */
  addFlag(flag: string): void {
    this.flags.add(flag);
  }

  /** Only an attorney can clear a flag, and it must be a deliberate act naming the flag. */
  clearFlag(actor: Actor, flag: string): void {
    this.#requireAttorney(actor, "clear flag");
    if (!this.flags.has(flag)) {
      throw new ReviewGateError(`flag '${flag}' is not set on work product '${this.id}'`);
    }
    this.flags.delete(flag);
    this.#record("clear_flag", actor, `flag=${flag}`);
  }

  submitForReview(actor: Actor): void {
    if (this.status !== "draft" && this.status !== "revision_requested") {
      throw new ReviewGateError(`cannot submit for review from status '${this.status}'`);
    }
    this.#transition(actor, "pending_review");
  }

  requestRevision(actor: Actor, note: string): void {
    this.#requireAttorney(actor, "request revision");
    if (this.status !== "pending_review") {
      throw new ReviewGateError(`cannot request revision from status '${this.status}'`);
    }
    this.#transition(actor, "revision_requested", note);
  }

  reject(actor: Actor, reason: string): void {
    this.#requireAttorney(actor, "reject");
    if (this.status !== "pending_review") {
      throw new ReviewGateError(`cannot reject from status '${this.status}'`);
    }
    this.#transition(actor, "rejected", reason);
  }

  approve(actor: Actor): void {
    this.#requireAttorney(actor, "approve");
    if (this.status !== "pending_review") {
      throw new ReviewGateError(`cannot approve from status '${this.status}'`);
    }
    if (this.flags.size > 0) {
      throw new ReviewGateError(
        `cannot approve '${this.id}': unresolved flags [${[...this.flags].join(", ")}] require attorney sign-off`,
      );
    }
    this.#transition(actor, "approved");
  }

  /** The only path by which content may leave the system — to a client, a filing, or an invoice. */
  release(actor: Actor): void {
    this.#requireAttorney(actor, "release");
    if (this.status !== "approved") {
      throw new ReviewGateError(
        `cannot release '${this.id}' from status '${this.status}': attorney approval is required first`,
      );
    }
    this.#transition(actor, "released");
  }

  #requireAttorney(actor: Actor, action: string): void {
    if (actor.role !== "attorney") {
      throw new ReviewGateError(`only an attorney may ${action} (got role '${actor.role}')`);
    }
  }

  #transition(actor: Actor, to: WorkProductStatus, note?: string): void {
    const from = this.status;
    this.status = to;
    const transition: WorkProductTransition = { from, to, actor, timestamp: new Date().toISOString(), note };
    this.history.push(transition);
    this.#record(`transition_${to}`, actor, note);
  }

  #record(action: string, actor: Actor, detail?: string): void {
    this.#auditLog.append({ actor, matterId: this.matterId, action: `work_product.${this.id}.${action}`, detail });
  }
}
