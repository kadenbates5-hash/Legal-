import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import { diffFields, type AuditLog } from "../core/audit.js";
import type { Matter, MatterInput, MatterStore } from "../core/matters.js";
import type { ConflictCheckResult, ConflictChecker } from "../core/conflicts.js";
import type { PartyRole } from "../core/matters.js";

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

  constructor(params: {
    store: MatterStore;
    checker: ConflictChecker;
    accessControl: AccessControl;
    auditLog: AuditLog;
  }) {
    this.#store = params.store;
    this.#checker = params.checker;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
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
