import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl, ParalegalAssignment } from "../core/access-control.js";
import type { AuthService, UserRole } from "../core/auth.js";

/**
 * The "Staff" panel's read-only directory: who works here, their role,
 * initials for the messaging/schedule panels' avatars, and (for
 * paralegals) which matter they're currently assigned to. Distinct from
 * `AccountsService`, which is attorney-only and owns account *management*
 * (create/disable/reset-password/assign) — this is just "who's on the
 * team," visible to every logged-in human so messaging has someone to
 * address and the schedule has someone to show. The `"system"` role
 * (the calendar integration's machine credential) is never created via
 * `AuthService.createUser`, so it never appears in this directory.
 */
export interface StaffMember {
  actorId: string;
  username: string;
  displayName: string;
  initials: string;
  role: UserRole;
  disabled: boolean;
  matterAssignment?: ParalegalAssignment;
}

/**
 * "Every logged-in human" here means every *staff* role — written
 * before the client portal existed. A client seeing the full internal
 * directory (every attorney/paralegal, who's assigned to which matter)
 * was never the intent, so `"client"` is denied by name, same as
 * `"system"`.
 */
function requireStaffRole(actor: Actor): void {
  if (actor.role === "system" || actor.role === "client") {
    throw new AccessDeniedError("the staff directory is not available to this role");
  }
}

/** e.g. "Jane Doe" -> "JD", "attorney1" -> "AT". Always 1-2 uppercase characters. */
export function initialsFor(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

export class StaffService {
  #auth: AuthService;
  #accessControl: AccessControl;

  constructor(auth: AuthService, accessControl: AccessControl) {
    this.#auth = auth;
    this.#accessControl = accessControl;
  }

  list(actor: Actor): StaffMember[] {
    requireStaffRole(actor);
    return this.#auth
      .listUsers()
      .map((u) => {
        const matterAssignment = u.role === "paralegal" ? this.#accessControl.getParalegalAssignment(u.actorId) : undefined;
        return {
          actorId: u.actorId,
          username: u.username,
          displayName: u.displayName,
          initials: initialsFor(u.displayName),
          role: u.role,
          disabled: u.disabled,
          ...(matterAssignment ? { matterAssignment } : {}),
        };
      });
  }
}
