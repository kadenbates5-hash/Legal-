import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl, ParalegalAssignment } from "../core/access-control.js";
import type { AuthService, User, UserRole } from "../core/auth.js";

/**
 * Attorney-facing account management. Adding/disabling users after the
 * one-time boot-time seed, and attorney-initiated password reset, are
 * covered here (self-service password change is `AuthService.
 * changePassword()`, wired directly into `server.ts` since it needs no
 * attorney gate — any logged-in user can change their own password).
 * MFA and self-service invites remain out of scope — see CLAUDE.md's
 * "Not yet built". Same pattern as `ReviewGateService` — every method
 * requires an attorney actor,
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
  displayName: string;
  disabled: boolean;
  /** Set after an attorney resets this account's password; cleared once the holder changes it themselves. */
  mustChangePassword: boolean;
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
      displayName: user.displayName,
      disabled: user.disabled,
      mustChangePassword: user.mustChangePassword,
      ...(matterAssignment ? { matterAssignment } : {}),
    };
  }

  list(actor: Actor): AccountSummary[] {
    requireAttorney(actor);
    return this.#auth.listUsers().map((u) => this.#summarize(u));
  }

  create(actor: Actor, params: { username: string; password: string; role: UserRole; actorId?: string; displayName?: string }): AccountSummary {
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

  /** Attorney sets a new password for a user who's lost theirs — see `AuthService.resetPassword` for what this actually does (marks mustChangePassword, revokes every live session). */
  resetPassword(actor: Actor, userId: string, newPassword: string): AccountSummary {
    requireAttorney(actor);
    return this.#summarize(this.#auth.resetPassword(userId, newPassword));
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
