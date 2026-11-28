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

/** Plain-data shape for persistence (§8's "not yet built" — persistence). */
export interface WorkProductSnapshot {
  id: string;
  matterId: string;
  kind: string;
  status: WorkProductStatus;
  content: string;
  flags: string[];
  history: WorkProductTransition[];
  /** Absent on snapshots written before it was recorded. */
  createdAt?: string;
  /**
   * Flags an attorney cleared on the content as it stands — re-raised if
   * that content changes. Absent on snapshots written before this existed;
   * `fromSnapshot` then recovers it from the audit log.
   */
  clearedFlags?: string[];
}

export class WorkProduct {
  readonly id: string;
  readonly matterId: string;
  readonly kind: string;
  status: WorkProductStatus = "draft";
  #content: string;
  readonly flags = new Set<string>();
  /**
   * Flags cleared since the content last changed. A clearance is an
   * attorney's sign-off on *this text* — "the Padilla advisory is handled
   * here" — so a revision re-raises it. See `reviseDraft`.
   */
  readonly #clearedFlags = new Set<string>();
  readonly history: WorkProductTransition[] = [];
  /**
   * When the draft was first created. `history` only records transitions,
   * so without this a draft never submitted has no date at all — the
   * matter timeline needs one. Undefined for drafts persisted before it
   * existed, which is shown as "date not recorded" rather than guessed.
   */
  createdAt: string | undefined = new Date().toISOString();

  #auditLog: AuditLog;

  constructor(params: { id: string; matterId: string; kind: string; content: string }, auditLog: AuditLog) {
    this.id = params.id;
    this.matterId = params.matterId;
    this.kind = params.kind;
    this.#content = params.content;
    this.#auditLog = auditLog;
  }

  get content(): string {
    return this.#content;
  }

  /**
   * The only way content may change. Deliberately blocked once a draft is
   * submitted for review (`pending_review`, `approved`, `released`) —
   * otherwise an attorney's approval could be silently invalidated by a
   * post-approval edit, which is exactly the hole the review gate exists
   * to close.
   */
  reviseDraft(actor: Actor, newContent: string): void {
    if (this.status !== "draft" && this.status !== "revision_requested") {
      throw new ReviewGateError(
        `cannot revise content from status '${this.status}': content is locked once submitted for review`,
      );
    }
    const changed = newContent !== this.#content;
    this.#content = newContent;
    this.#record("revise_draft", actor, undefined);
    // A cleared flag was a sign-off on the old text. Without this, an
    // attorney could clear the Padilla advisory on a draft that carried
    // one, ask for a revision, and approve the rewrite — advisory removed
    // — with nothing left to stop it. A rewrite by the paralegal or the
    // Assistant now brings every cleared flag back for a fresh sign-off.
    if (changed && this.#clearedFlags.size > 0) {
      const reraised = [...this.#clearedFlags];
      for (const flag of reraised) this.flags.add(flag);
      this.#clearedFlags.clear();
      this.#record("flags_reraised", actor, `flags=${reraised.join(",")} (content changed after they were cleared)`);
    }
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
    this.#clearedFlags.add(flag);
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

  /** Plain-data snapshot for persistence. Round-trips exactly via `fromSnapshot`. */
  toSnapshot(): WorkProductSnapshot {
    return {
      id: this.id,
      matterId: this.matterId,
      kind: this.kind,
      status: this.status,
      content: this.#content,
      flags: [...this.flags],
      history: this.history.map((t) => ({ ...t })),
      ...(this.createdAt ? { createdAt: this.createdAt } : {}),
      clearedFlags: [...this.#clearedFlags],
    };
  }

  /**
   * Rehydrates a `WorkProduct` from a persisted snapshot, restoring exact
   * status/flags/history — including states like `approved`/`released`
   * that the normal constructor + transition methods can't reach directly.
   * This is the one legitimate way to bypass the constructor's
   * draft-first flow; it exists only for loading persisted state, not as
   * a general escape hatch. Business rules still hold afterward — e.g. a
   * rehydrated `approved` work product still refuses `reviseDraft`.
   */
  static fromSnapshot(snapshot: WorkProductSnapshot, auditLog: AuditLog): WorkProduct {
    const workProduct = new WorkProduct(
      { id: snapshot.id, matterId: snapshot.matterId, kind: snapshot.kind, content: snapshot.content },
      auditLog,
    );
    workProduct.status = snapshot.status;
    for (const flag of snapshot.flags) workProduct.flags.add(flag);
    workProduct.history.push(...snapshot.history.map((t) => ({ ...t })));
    workProduct.createdAt = snapshot.createdAt;
    if (snapshot.clearedFlags) {
      for (const flag of snapshot.clearedFlags) if (!workProduct.flags.has(flag)) workProduct.#clearedFlags.add(flag);
    } else {
      // Written before cleared flags were kept: recover them from the log.
      const { cleared, stale } = flagClearancesFromLog(auditLog, snapshot.id);
      for (const flag of cleared) if (!workProduct.flags.has(flag)) workProduct.#clearedFlags.add(flag);
      // A flag cleared and then followed by a rewrite was never signed off
      // on the text as it now stands. Until it's approved, that draft gets
      // the flag back, as a revision now would give it.
      if (snapshot.status === "draft" || snapshot.status === "pending_review" || snapshot.status === "revision_requested") {
        for (const flag of stale) workProduct.flags.add(flag);
      }
    }
    return workProduct;
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

/**
 * For a snapshot written before cleared flags were kept, what the audit
 * log says about this work product's flags: `cleared` since the last
 * revision, and `stale` — cleared, then followed by a revision, and not
 * cleared again since. The log can't say whether a revision changed the
 * text, so every one counts as a change: the safe direction to be wrong.
 */
function flagClearancesFromLog(auditLog: AuditLog, workProductId: string): { cleared: string[]; stale: string[] } {
  const prefix = `work_product.${workProductId}.`;
  const cleared = new Set<string>();
  const stale = new Set<string>();
  for (const entry of auditLog.read("attorney")) {
    if (!entry.action.startsWith(prefix)) continue;
    const action = entry.action.slice(prefix.length);
    if (action === "revise_draft") {
      for (const flag of cleared) stale.add(flag);
      cleared.clear();
    } else if (action === "clear_flag") {
      const flag = /^flag=(.+)$/.exec(entry.detail ?? "")?.[1];
      if (flag) {
        cleared.add(flag);
        stale.delete(flag);
      }
    }
  }
  return { cleared: [...cleared], stale: [...stale] };
}
