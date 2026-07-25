import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuditEntry, AuditLog } from "../core/audit.js";

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

  list(actor: Actor, matterId?: string): AuditEntry[] {
    requireAttorney(actor);
    return this.#auditLog.read("attorney", matterId ? { matterId } : undefined);
  }
}
