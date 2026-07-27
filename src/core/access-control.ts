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
  | "high_sensitivity"
  | "client_portal";

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

/**
 * A client account's grant to view one matter through the client portal.
 * Unlike a paralegal assignment (one matter at a time, because a
 * paralegal *acts* on a matter) this is a plain whitelist entry — a
 * repeat client can reasonably have several matters over time, and
 * granting a second doesn't need to revoke the first.
 */
export interface ClientMatterGrant {
  actorId: string;
  matterId: string;
}

const RECEPTIONIST_ALLOWED: ReadonlySet<FieldCategory> = new Set(["intake", "scheduling"]);

export class AccessControl {
  #paralegalAssignments = new Map<string, ParalegalAssignment>();
  /** actorId -> the set of matterIds a client account may view. */
  #clientAssignments = new Map<string, Set<string>>();
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

  /** Read accessor for surfaces (e.g. the Accounts panel) that need to show/manage a paralegal's current assignment. */
  getParalegalAssignment(actorId: string): ParalegalAssignment | undefined {
    const assignment = this.#paralegalAssignments.get(actorId);
    return assignment ? { ...assignment } : undefined;
  }

  /** Grants a client account visibility into one matter. Additive — granting a second matter doesn't revoke the first. */
  grantClientAccess(actorId: string, matterId: string): void {
    const set = this.#clientAssignments.get(actorId) ?? new Set<string>();
    set.add(matterId);
    this.#clientAssignments.set(actorId, set);
  }

  revokeClientAccess(actorId: string, matterId: string): void {
    this.#clientAssignments.get(actorId)?.delete(matterId);
  }

  /** Every matterId this client account can view — the Accounts panel's read of a client's current grants. */
  getClientMatterIds(actorId: string): string[] {
    return [...(this.#clientAssignments.get(actorId) ?? [])];
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

    if (actor.role === "client") {
      // A client's whole surface is the portal category — case_file,
      // billing_internal etc. are staff-only even for a matter the
      // client is otherwise granted, since those carry work product and
      // internal notes a client-safe view has deliberately not filtered.
      if (category !== "client_portal") {
        return "client role is scoped to the client portal only";
      }
      const matterIds = this.#clientAssignments.get(actor.id);
      if (!matterIds?.has(matterId)) {
        return "client account has not been granted access to this matter";
      }
      return undefined;
    }

    // staff/system actors: default deny unless explicitly modeled above.
    return "role not authorized by default policy";
  }

  /** All current paralegal-matter assignments — e.g. so the Cases panel can discover which matters exist. */
  listAssignments(): ParalegalAssignment[] {
    return [...this.#paralegalAssignments.values()].map((a) => ({ ...a }));
  }

  /** Every client-matter grant, flattened — so the client portal (and the Accounts panel) can discover which matters exist. */
  listClientAssignments(): ClientMatterGrant[] {
    const out: ClientMatterGrant[] = [];
    for (const [actorId, matterIds] of this.#clientAssignments) {
      for (const matterId of matterIds) out.push({ actorId, matterId });
    }
    return out;
  }

  /** Plain-data snapshot for persistence — paralegal-matter assignments otherwise vanish on every restart. */
  toSnapshot(): ParalegalAssignment[] {
    return this.listAssignments();
  }

  /** Separate from `toSnapshot()` so an old snapshot (predating client accounts) round-trips unchanged — see `fromSnapshot`'s optional third parameter. */
  clientAccessSnapshot(): ClientMatterGrant[] {
    return this.listClientAssignments();
  }

  static fromSnapshot(
    auditLog: AuditLog,
    snapshot: readonly ParalegalAssignment[],
    clientSnapshot: readonly ClientMatterGrant[] = [],
  ): AccessControl {
    const accessControl = new AccessControl(auditLog);
    for (const assignment of snapshot) {
      accessControl.#paralegalAssignments.set(assignment.actorId, { ...assignment });
    }
    for (const grant of clientSnapshot) {
      accessControl.grantClientAccess(grant.actorId, grant.matterId);
    }
    return accessControl;
  }
}
