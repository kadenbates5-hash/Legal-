import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AuthService, User, UserRole } from "../core/auth.js";

/**
 * Attorney-facing account management (the "Not yet built" gap CLAUDE.md
 * used to flag: password reset/MFA are still out of scope, but adding and
 * disabling users after the one-time boot-time seed is not). Same pattern
 * as `ReviewGateService` — every method requires an attorney actor,
 * including plain reads, since a receptionist/paralegal credential has no
 * business seeing the account list at all.
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
}

function requireAttorney(actor: Actor): void {
  if (actor.role !== "attorney") {
    throw new AccessDeniedError(`account management is attorney-only (got role '${actor.role}')`);
  }
}

function summarize(user: User): AccountSummary {
  return { id: user.id, username: user.username, role: user.role, actorId: user.actorId, disabled: user.disabled };
}

export class AccountsService {
  #auth: AuthService;

  constructor(auth: AuthService) {
    this.#auth = auth;
  }

  list(actor: Actor): AccountSummary[] {
    requireAttorney(actor);
    return this.#auth.listUsers().map(summarize);
  }

  create(actor: Actor, params: { username: string; password: string; role: UserRole; actorId?: string }): AccountSummary {
    requireAttorney(actor);
    return summarize(this.#auth.createUser(params));
  }

  disable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    return summarize(this.#auth.setDisabled(userId, true));
  }

  enable(actor: Actor, userId: string): AccountSummary {
    requireAttorney(actor);
    return summarize(this.#auth.setDisabled(userId, false));
  }
}
