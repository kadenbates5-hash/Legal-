import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl, ParalegalAssignment } from "../core/access-control.js";
import type { AuthService, User, UserRole } from "../core/auth.js";

/**
 * Attorney-facing account management (the "Not yet built" gap CLAUDE.md
 * used to flag: password reset/MFA are still out of scope, but adding and
 * disabling users after the one-time boot-time seed is not). Same pattern
 * as `ReviewGateService` — every method requires an attorney actor,
 * including plain reads, since a receptionist/paralegal credential has no
 * business seeing the account list at all.
 *
 * Also owns matter-assignment for paralegal accounts (`AccessControl`'s
 * `assignParalegal`/`revokeParalegalAssignment`) — a paralegal account
 * created here has no case-file access at all until an attorney assigns
 * it to a matter, which is exactly the scoping `access-control.ts`
 * enforces for the Drafting panel.
 *
 * Never hands back a raw `User` — `passwordHash`/`salt` never leave
 * `AuthService`.
 */
export interface AccountSummary {
  id: string;
  username: string;
  role: UserRole;
  actorId: string;
  disabled: boolean;
  /** Only ever set for role "paralegal" — the matter (if any) this account is currently scoped to. */
  matterAssignment?: ParalegalAssignment;
}

function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`account management is attorney-only (got role '${actor.role}')`);
  }
}

export class AccountsService {
  #auth: AuthService;
  #accessControl: AccessControl;

  constructor(auth: AuthService, accessControl: AccessControl) {
    this.#auth = auth;
    this.#accessControl = accessControl;
  }

  #summarize(user: User): AccountSummary {
    const matterAssignment =
      user.role === "paralegal" ? this.#accessControl.getParalegalAssignment(user.actorId) : undefined;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      actorId: user.actorId,
      disabled: user.disabled,
      ...(matterAssignment ? { matterAssignment } : {}),
    };
  }

  list(actor: Actor): AccountSummary[] {
    requireAttorney(actor);
    return this.#auth.listUsers().map((u) => this.#summarize(u));
  }

  create(actor: Actor, params: { username: string; password: string; role: UserRole; actorId?: string }): AccountSummary {
    requireAttorney(actor);
    return this.#summarize(this.#auth.createUser(params));
  }

  disable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    return this.#summarize(this.#auth.setDisabled(userId, true));
  }

  enable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    return this.#summarize(this.#auth.setDisabled(userId, false));
  }

  /** Assigns (or re-assigns) a paralegal account to exactly one matter — see access-control.ts's "one matter at a time." */
  assignMatter(actor: Actor, userId: string, matterId: string, highSensitivityGranted?: boolean): AccountSummary {
    requireAttorney(actor);
    const user = this.#requireParalegal(userId);
    this.#accessControl.assignParalegal(user.actorId, matterId, { highSensitivityGranted: highSensitivityGranted ?? false });
    return this.#summarize(user);
  }

  unassignMatter(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    const user = this.#requireParalegal(userId);
    this.#accessControl.revokeParalegalAssignment(user.actorId);
    return this.#summarize(user);
  }

  #requireParalegal(userId: string): User {
    const user = this.#auth.listUsers().find((u) => u.id === userId);
    if (!user) {
      throw new Error(`no user '${userId}'`);
    }
    if (user.role !== "paralegal") {
      throw new Error(`matter assignment only applies to paralegal accounts (user '${userId}' has role '${user.role}')`);
    }
    return user;
  }
}
