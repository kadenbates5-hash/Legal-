import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditEntry, AuditFilter, AuditLog, IntegrityReport } from "../core/audit.js";

/**
 * Backs Docket's "Audit Log" panel. `AuditLog.read()` already requires an
 * explicit counsel-aware reader role (`"attorney"` vs.
 * `"system_admin_no_content"`), but that's a parameter any caller could
 * pass — this service is the actual attorney-only gate: every method
 * requires an attorney actor, same as `ReviewGateService`/`AccountsService`,
 * and always reads with role `"attorney"` since the caller is already
 * confirmed to be one.
 */
function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`the audit log is attorney-only (got role '${actor.role}')`);
  }
}

export class AuditService {
  #auditLog: AuditLog;

  constructor(auditLog: AuditLog) {
    this.#auditLog = auditLog;
  }

  list(actor: Actor, filter?: { matterId?: string } & AuditFilter): AuditEntry[] {
    requireAttorney(actor);
    return this.#auditLog.read("attorney", filter);
  }

  /**
   * Checks the hash chain and reports where, if anywhere, it breaks.
   *
   * Exposed to attorneys rather than kept as an internal ops check
   * because the people who need to be able to say "this record is
   * intact" are the ones answerable for it. It is deliberately a
   * *report*, not a repair: there is no code path that rewrites a
   * broken chain to make it verify again, since that is
   * indistinguishable from covering up whatever broke it.
   */
  verifyIntegrity(actor: Actor): IntegrityReport {
    requireAttorney(actor);
    // Not itself audited: verification is a read, and logging every
    // check would grow the log it is checking on every page load.
    return this.#auditLog.verifyIntegrity();
  }
}
