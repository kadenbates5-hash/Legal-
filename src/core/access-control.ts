import { AccessDeniedError, type Actor } from "./types.js";
import type { AuditLog } from "./audit.js";

/**
 * §5 access control, enforced technically rather than by policy:
 *
 *  - Receptionist agent: scoped to intake/scheduling fields only — no
 *    case-file read access.
 *  - Paralegal agent: scoped to its assigned matter only — no cross-matter
 *    visibility or shared context between cases.
 *  - High-sensitivity data (cooperating witness/informant info, §3) needs an
 *    explicit grant beyond ordinary matter-scoping even for the assigned
 *    paralegal.
 */
export type FieldCategory =
  | "intake"
  | "scheduling"
  | "case_file"
  | "billing_internal"
  | "high_sensitivity";

export interface AccessRequest {
  actor: Actor;
  matterId: string;
  category: FieldCategory;
}

export interface ParalegalAssignment {
  actorId: string;
  matterId: string;
  highSensitivityGranted: boolean;
}

const RECEPTIONIST_ALLOWED: ReadonlySet<FieldCategory> = new Set(["intake", "scheduling"]);

export class AccessControl {
  #paralegalAssignments = new Map<string, ParalegalAssignment>();
  #auditLog: AuditLog;

  constructor(auditLog: AuditLog) {
    this.#auditLog = auditLog;
  }

  /** A paralegal agent instance is provisioned for exactly one matter at a time. */
  assignParalegal(actorId: string, matterId: string, options?: { highSensitivityGranted?: boolean }): void {
    this.#paralegalAssignments.set(actorId, {
      actorId,
      matterId,
      highSensitivityGranted: options?.highSensitivityGranted ?? false,
    });
  }

  revokeParalegalAssignment(actorId: string): void {
    this.#paralegalAssignments.delete(actorId);
  }

  /** Throws AccessDeniedError on any violation; never returns a partial/degraded result. */
  authorize(request: AccessRequest): void {
    const { actor, matterId, category } = request;
    const denial = this.#checkDenial(actor, matterId, category);

    this.#auditLog.append({
      actor,
      matterId,
      action: denial ? "access_denied" : "access_granted",
      detail: `category=${category} reason=${denial ?? "ok"}`,
    });

    if (denial) {
      throw new AccessDeniedError(
        `${actor.role} '${actor.id}' denied ${category} access on matter '${matterId}': ${denial}`,
      );
    }
  }

  #checkDenial(actor: Actor, matterId: string, category: FieldCategory): string | undefined {
    if (actor.role === "attorney") return undefined;

    if (actor.role === "receptionist") {
      if (!RECEPTIONIST_ALLOWED.has(category)) {
        return "receptionist scoped to intake/scheduling fields only";
      }
      return undefined;
    }

    if (actor.role === "paralegal") {
      const assignment = this.#paralegalAssignments.get(actor.id);
      if (!assignment) {
        return "paralegal agent has no active matter assignment";
      }
      if (assignment.matterId !== matterId) {
        return "paralegal agent is scoped to a different matter (no cross-matter visibility)";
      }
      if (category === "high_sensitivity" && !assignment.highSensitivityGranted) {
        return "high-sensitivity tier requires an explicit grant beyond standard matter-scoping";
      }
      return undefined;
    }

    // staff/system actors: default deny unless explicitly modeled above.
    return "role not authorized by default policy";
  }
}
