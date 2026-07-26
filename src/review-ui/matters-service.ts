import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import { diffFields, type AuditLog } from "../core/audit.js";
import { addYears, type Matter, type MatterInput, type MatterStore } from "../core/matters.js";
import type { TrustLedger } from "../core/trust-ledger.js";
import type { InvoiceStore } from "../core/invoicing.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { ConflictCheckResult, ConflictChecker } from "../core/conflicts.js";
import type { PartyRole } from "../core/matters.js";

/**
 * Refusing to close a matter isn't a malformed request or an access
 * problem — it's the ledger saying no, so it gets its own type and a 409.
 */
export class MatterClosingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatterClosingError";
  }
}

/** Plain dollars for a message, without pulling the invoice renderer into this file. */
function formatCentsPlain(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function requireLegalStaff(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`matters and conflicts are paralegal/attorney-only (got role '${actor.role}')`);
  }
}

function requireAttorney(actor: Actor, what: string): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`${what} is attorney-only (got role '${actor.role}')`);
  }
}

/**
 * Backs the "Matters" and "Conflicts" panels.
 *
 * Two different access shapes live here on purpose, because the two
 * features have genuinely different requirements:
 *
 * - **Matter records** are matter-scoped like everything else. Reading or
 *   editing one goes through `AccessControl`, so a paralegal still only
 *   sees the matter they're assigned to.
 * - **Conflict checking is deliberately *not* matter-scoped.** ABA Model
 *   Rule 1.10 imputes one lawyer's conflict to the entire firm, so a
 *   check that only searched the caller's own matters would give a
 *   dangerously clean answer. Instead the check searches everything and
 *   the *result* is limited to what a conflicts check has to reveal:
 *   which matter matched, its title/status, and the matching party. That
 *   is the minimum needed to discharge the duty, and it's why running a
 *   check is logged to the audit trail every time.
 */
export interface ConflictCheckInput {
  names: string[];
  roleByName?: Record<string, PartyRole>;
  excludeMatterId?: string;
}

/**
 * A matter as flat, comparable fields. Parties are grouped by role and
 * joined into one string per role, so an audit entry reads "adverseParties:
 * 'The State' → 'The State, Acme Inc.'" rather than a JSON blob nobody
 * will read.
 */
function flattenMatter(matter: Matter): Record<string, unknown> {
  // Returns undefined rather than "" when a role has no parties, so the
  // audit diff reads "cleared" instead of showing an empty cell that
  // could equally mean "unchanged" or "set to blank".
  const named = (role: string) =>
    matter.parties
      .filter((p) => p.role === role)
      .map((p) => (p.email ? `${p.name} <${p.email}>` : p.name))
      .join(", ") || undefined;
  return {
    title: matter.title,
    status: matter.status,
    practiceAreaId: matter.practiceAreaId,
    responsibleAttorneyId: matter.responsibleAttorneyId,
    description: matter.description,
    clients: named("client"),
    adverseParties: named("adverse"),
    relatedParties: named("related"),
  };
}

export class MattersService {
  #store: MatterStore;
  #checker: ConflictChecker;
  #accessControl: AccessControl;
  #auditLog: AuditLog;

  #trust: TrustLedger | undefined;
  #invoices: InvoiceStore | undefined;
  #workProducts: WorkProductStore | undefined;
  #retentionYears: number;

  constructor(params: {
    store: MatterStore;
    checker: ConflictChecker;
    accessControl: AccessControl;
    auditLog: AuditLog;
    /** Closing a matter checks this: client funds still held block the close outright. */
    trust?: TrustLedger;
    /** Consulted for closing *warnings* only — an unpaid bill never blocks a close. */
    invoices?: InvoiceStore;
    workProducts?: WorkProductStore;
    /** How long a closed file is kept. 0 records no retention date at all. */
    retentionYears?: number;
  }) {
    this.#store = params.store;
    this.#checker = params.checker;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#trust = params.trust;
    this.#invoices = params.invoices;
    this.#workProducts = params.workProducts;
    this.#retentionYears = params.retentionYears ?? 0;
  }

  /** Matter records the caller can actually open, so a paralegal sees only their own. */
  list(actor: Actor): Matter[] {
    requireLegalStaff(actor);
    return this.#store.listAll().filter((m) => this.#canSee(actor, m.matterId));
  }

  get(actor: Actor, matterId: string): Matter {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const matter = this.#store.get(matterId);
    if (!matter) throw new Error(`no matter '${matterId}'`);
    return matter;
  }

  /**
   * Creating or editing a matter record — including who the client and
   * adverse parties are — is attorney-only. Those fields are the input to
   * every future conflicts check, so letting them be edited more widely
   * would let someone quietly weaken the firm's screening.
   */
  upsert(actor: Actor, matterId: string, input: MatterInput): Matter {
    requireAttorney(actor, "editing a matter record");
    // Read the record *before* the write, so the audit entry can say what
    // actually changed rather than only that something did. Party lists
    // matter most here: they are the input to every future conflicts
    // check, and "who quietly removed the adverse party" is precisely
    // the question this log has to be able to answer.
    const before = this.#store.get(matterId);
    const record = this.#store.upsert(matterId, input);
    const changes = diffFields(
      before ? flattenMatter(before) : undefined,
      flattenMatter(record),
      ["title", "status", "practiceAreaId", "responsibleAttorneyId", "description", "clients", "adverseParties", "relatedParties"],
    );
    this.#auditLog.append({
      actor,
      matterId: record.matterId,
      action: before ? "matter_record_updated" : "matter_record_created",
      detail: `status=${record.status} parties=${record.parties.length}`,
      ...(changes.length ? { changes } : {}),
    });
    return record;
  }

  /**
   * Closes a matter.
   *
   * The one rule enforced in code rather than asked of a human:
   * **a matter holding client funds in trust cannot be closed.** Closing
   * a file with the client's money still in the trust account is how
   * balances become unclaimed funds — money the firm is holding for
   * someone it has stopped dealing with, which in most jurisdictions
   * triggers escheat obligations and is a reliable way to fail a trust
   * audit. The money must be refunded or applied to an invoice first,
   * both of which the Trust and Invoices panels already do.
   *
   * Everything else is reported as a **warning**, not a block. An
   * unpaid invoice is a perfectly ordinary reason to close a matter and
   * keep chasing the debt; work product still awaiting review may
   * genuinely no longer need it. Those are the closing attorney's calls,
   * and refusing them would just teach people to route around this.
   */
  close(
    actor: Actor,
    matterId: string,
    params: { closingNote: string; retentionYears?: number },
  ): { matter: Matter; warnings: string[] } {
    requireAttorney(actor, "closing a matter");
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const existing = this.#store.get(matterId);
    if (existing?.status === "closed") throw new Error(`matter '${matterId}' is already closed`);
    if (!params.closingNote.trim()) throw new Error("closing a matter needs a note recording its disposition");

    const trustBalance = this.#trust?.balanceForMatter(matterId) ?? 0;
    if (trustBalance > 0) {
      throw new MatterClosingError(
        `matter '${matterId}' still holds ${formatCentsPlain(trustBalance)} of the client's money in trust. ` +
          "Refund it or apply it to an invoice before closing — a closed file with client funds in it becomes unclaimed property.",
      );
    }

    const warnings = this.#closingWarnings(matterId);
    const years = params.retentionYears ?? this.#retentionYears;
    const closedOn = new Date().toISOString().slice(0, 10);
    const matter = this.#store.upsert(matterId, {
      status: "closed",
      closingNote: params.closingNote.trim(),
      ...(years > 0 ? { retentionUntil: addYears(closedOn, years) } : {}),
    });

    this.#auditLog.append({
      actor,
      matterId,
      action: "matter_closed",
      detail:
        `note=${params.closingNote.trim()} retentionUntil=${matter.retentionUntil ?? "none"}` +
        (warnings.length ? ` warnings=${warnings.length}` : ""),
    });
    return { matter, warnings };
  }

  /** Reopening is attorney-only and audited: a closed file is a statement, and unmaking it should be visible. */
  reopen(actor: Actor, matterId: string, reason: string): Matter {
    requireAttorney(actor, "reopening a matter");
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    if (!reason.trim()) throw new Error("reopening a matter needs a reason");
    const matter = this.#store.upsert(matterId, { status: "open" });
    this.#auditLog.append({ actor, matterId, action: "matter_reopened", detail: `reason=${reason.trim()}` });
    return matter;
  }

  /**
   * Closed matters whose retention period has run out.
   *
   * A list, never an action. What happens next — notifying the client,
   * transferring the file, destroying it — is a judgement with notice
   * obligations attached and differs by jurisdiction. Software's job
   * here is to stop a firm from keeping everything forever by default
   * because nobody remembered to look.
   */
  listRetentionDue(actor: Actor, asOf: Date = new Date()): Matter[] {
    requireAttorney(actor, "reviewing file retention");
    const today = asOf.toISOString().slice(0, 10);
    return this.#store
      .listAll()
      .filter((m) => m.status === "closed" && m.retentionUntil && m.retentionUntil <= today)
      .sort((a, b) => (a.retentionUntil ?? "").localeCompare(b.retentionUntil ?? ""));
  }

  /** What an attorney should know before closing — surfaced, never enforced. */
  #closingWarnings(matterId: string): string[] {
    const warnings: string[] = [];

    const outstanding = (this.#invoices?.listByMatter(matterId) ?? []).filter(
      (i) => (i.status === "sent" || i.status === "partially_paid") && this.#invoices!.totals(i.id).balanceCents > 0,
    );
    if (outstanding.length > 0) {
      const due = outstanding.reduce((sum, i) => sum + this.#invoices!.totals(i.id).balanceCents, 0);
      warnings.push(
        `${outstanding.length} unpaid invoice(s) totalling ${formatCentsPlain(due)} — closing the matter doesn't write the debt off, but nobody will be watching the receivables list for it.`,
      );
    }

    const pending = (this.#workProducts?.listByMatter(matterId) ?? []).filter(
      (wp) => wp.status === "draft" || wp.status === "pending_review" || wp.status === "revision_requested",
    );
    if (pending.length > 0) {
      warnings.push(`${pending.length} work product(s) never finished review — they will stay in the file unreleased.`);
    }

    return warnings;
  }

  /**
   * Runs a firm-wide conflicts check. Logged unconditionally: being able
   * to show *that* a check was run, by whom, over which names, is part of
   * the point — it's the evidence the obligation was discharged.
   */
  checkConflicts(actor: Actor, input: ConflictCheckInput): ConflictCheckResult {
    requireLegalStaff(actor);
    const result = this.#checker.check({
      names: input.names,
      ...(input.roleByName ? { roleByName: input.roleByName } : {}),
      ...(input.excludeMatterId ? { excludeMatterId: input.excludeMatterId } : {}),
    });
    this.#auditLog.append({
      actor,
      matterId: input.excludeMatterId,
      action: "conflict_check_run",
      detail:
        `names=${input.names.join("; ")} hits=${result.hits.length} ` +
        `requiresAttorneyReview=${result.requiresAttorneyReview}`,
    });
    return result;
  }

  #canSee(actor: Actor, matterId: string): boolean {
    try {
      this.#accessControl.authorize({ actor, matterId, category: "case_file" });
      return true;
    } catch {
      return false;
    }
  }
}
