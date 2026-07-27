import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl, ParalegalAssignment } from "../core/access-control.js";
import type { AuthService, User, UserRole } from "../core/auth.js";
import { LoginThrottle } from "../core/login-throttle.js";
import type { AuditLog } from "../core/audit.js";

/**
 * Attorney-facing account management. Adding/disabling users after the
 * one-time boot-time seed, and attorney-initiated password reset, are
 * covered here (self-service password change is `AuthService.
 * changePassword()`, wired directly into `server.ts` since it needs no
 * attorney gate — any logged-in user can change their own password).
 * Attorney-initiated MFA reset lives here too, for the same reason
 * password reset does — it is an override of someone else's credential
 * (`resetMfa`). Enrolling in MFA is self-service and lives on the
 * routes in `server.ts`, since nobody else should be able to add a
 * second factor to your account. Self-service invites remain out of
 * scope — see CLAUDE.md's "Not yet built". Same pattern as
 * `ReviewGateService` — every method
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
  /** Whether this account requires a second factor at login. The secret itself never leaves `AuthService`. */
  mfaEnabled: boolean;
  /** Counted so an attorney can see who is one lost phone away from needing a reset. */
  recoveryCodesRemaining: number;
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
  #loginThrottle: LoginThrottle | undefined;
  #auditLog: AuditLog | undefined;

  constructor(
    auth: AuthService,
    accessControl: AccessControl,
    loginThrottle?: LoginThrottle,
    /** Optional so existing call sites keep working; wired in production. */
    auditLog?: AuditLog,
  ) {
    this.#auth = auth;
    this.#accessControl = accessControl;
    this.#loginThrottle = loginThrottle;
    this.#auditLog = auditLog;
  }

  /**
   * Account changes are firm-level, not matter-level, so they carry no
   * matterId — except matter assignment, which is exactly a grant of
   * access to one matter and is filed under it.
   */
  #audit(actor: Actor, action: string, detail: string, matterId?: string): void {
    this.#auditLog?.append({ actor, matterId, action, detail });
  }

  /**
   * Clears a brute-force lockout so a colleague who fatfingered their
   * password five times doesn't have to sit out the full window. This is
   * the escape hatch that makes username-keyed throttling safe to run:
   * without it, anyone able to send failed logins could deny a real
   * attorney access to their own matters for as long as they kept it up.
   * Attorney-gated like everything else here, and it only clears counters
   * — it never reveals whether the username exists or logs anyone in.
   */
  clearLoginLockout(actor: Actor, username: string): { cleared: boolean } {
    requireAttorney(actor);
    if (!this.#loginThrottle) return { cleared: false };
    this.#loginThrottle.recordSuccess([LoginThrottle.usernameKey(username)]);
    this.#audit(actor, "login_lockout_cleared", `username=${username}`);
    return { cleared: true };
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
      mfaEnabled: user.mfa !== undefined,
      recoveryCodesRemaining: (user.mfa?.recoveryCodes ?? []).filter((c) => !c.usedAt).length,
      ...(matterAssignment ? { matterAssignment } : {}),
    };
  }

  list(actor: Actor): AccountSummary[] {
    requireAttorney(actor);
    return this.#auth.listUsers().map((u) => this.#summarize(u));
  }

  create(actor: Actor, params: { username: string; password: string; role: UserRole; actorId?: string; displayName?: string }): AccountSummary {
    requireAttorney(actor);
    const user = this.#auth.createUser(params);
    // Never the password, obviously — but who granted whom what role, and
    // when, is the first thing anyone reconstructing an incident wants.
    this.#audit(actor, "account_created", `user=${user.id} username=${user.username} role=${user.role} actorId=${user.actorId}`);
    return this.#summarize(user);
  }

  disable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    const user = this.#auth.setDisabled(userId, true);
    this.#audit(actor, "account_disabled", `user=${user.id} username=${user.username}`);
    return this.#summarize(user);
  }

  enable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    const user = this.#auth.setDisabled(userId, false);
    this.#audit(actor, "account_enabled", `user=${user.id} username=${user.username}`);
    return this.#summarize(user);
  }

  /** Attorney sets a new password for a user who's lost theirs — see `AuthService.resetPassword` for what this actually does (marks mustChangePassword, revokes every live session). */
  resetPassword(actor: Actor, userId: string, newPassword: string): AccountSummary {
    requireAttorney(actor);
    const user = this.#auth.resetPassword(userId, newPassword);
    this.#audit(actor, "account_password_reset", `user=${user.id} username=${user.username}`);
    return this.#summarize(user);
  }

  /**
   * Turns off someone else's second factor — the last resort for a lost
   * phone and lost recovery codes both.
   *
   * This is a **real bypass of another person's authentication**, and it
   * is the single most attractive action in this panel to an attacker
   * who has already compromised one attorney account: do this, then log
   * in as anyone with just their password. So it is deliberately loud
   * rather than quiet — audited with who did it to whom, and it revokes
   * every one of that user's live sessions (`AuthService.disableMfa`)
   * so the change can't be used to ride an existing session.
   *
   * It cannot be made safer by restricting it further, only less usable:
   * someone has to be able to do this, and in a firm this size that
   * someone is an attorney. What makes it survivable is that it leaves a
   * record, in a log whose integrity is separately provable.
   */
  resetMfa(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    const before = this.#auth.mfaStatus(userId);
    const user = this.#auth.disableMfa(userId);
    this.#audit(
      actor,
      "account_mfa_reset",
      `user=${user.id} username=${user.username} wasEnabled=${before.enabled}`,
    );
    return this.#summarize(user);
  }

  /** Assigns (or re-assigns) a paralegal account to exactly one matter — see access-control.ts's "one matter at a time." */
  assignMatter(actor: Actor, userId: string, matterId: string, highSensitivityGranted?: boolean): AccountSummary {
    requireAttorney(actor);
    const user = this.#requireParalegal(userId);
    const previous = this.#accessControl.getParalegalAssignment(user.actorId);
    this.#accessControl.assignParalegal(user.actorId, matterId, { highSensitivityGranted: highSensitivityGranted ?? false });
    this.#audit(
      actor,
      "matter_assigned",
      `user=${user.id} username=${user.username} highSensitivity=${highSensitivityGranted ?? false}` +
        (previous?.matterId && previous.matterId !== matterId ? ` replacedMatter=${previous.matterId}` : ""),
      matterId,
    );
    return this.#summarize(user);
  }

  unassignMatter(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    const user = this.#requireParalegal(userId);
    const previous = this.#accessControl.getParalegalAssignment(user.actorId);
    this.#accessControl.revokeParalegalAssignment(user.actorId);
    this.#audit(actor, "matter_unassigned", `user=${user.id} username=${user.username}`, previous?.matterId);
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
