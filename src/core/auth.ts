import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AgentRole } from "./types.js";

/**
 * Real authentication for the review-gate UI (§5/§6 "not yet built — real
 * auth" is now built). Replaces the `x-actor-id`/`x-actor-role` header
 * stand-in in `review-ui/server.ts` with actual credentialed accounts:
 * scrypt-hashed passwords, server-side sessions issued on login, and a
 * "remember me" option that extends session lifetime rather than skipping
 * login entirely — there is no path to a valid actor that doesn't go
 * through `login()` at least once.
 *
 * A `"system"` role user is deliberately NOT created here via
 * username/password — see `verifySystemApiKey` — because it represents a
 * machine credential (the calendar-integration due-diligence item from
 * CLAUDE.md's "Not yet built"), not a human login.
 */
export type UserRole = AgentRole | "attorney" | "staff";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly salt: string;
  readonly role: UserRole;
  /** The Actor.id this user maps to for authorization checks (access-control, scheduling assignment, etc.). */
  readonly actorId: string;
  /** Disabled accounts can never log in again and have every live session revoked immediately — see `setDisabled`. */
  readonly disabled: boolean;
}

export interface Session {
  readonly token: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly remember: boolean;
}

export interface SystemApiKeyRecord {
  readonly hash: string;
  readonly salt: string;
}

export interface AuthSnapshot {
  users: User[];
  sessions: Session[];
  systemApiKey?: SystemApiKeyRecord;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const SCRYPT_KEYLEN = 64;
/** No "remember me": long enough to not force a re-login mid-workday, short enough to matter if a device is lost. */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** "Remember me": the whole point is "log in once" — weeks, not hours. */
const REMEMBER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashSecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, SCRYPT_KEYLEN).toString("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

let userSequence = 0;
function nextUserId(): string {
  userSequence += 1;
  return `user_${userSequence}_${randomBytes(4).toString("hex")}`;
}

export class AuthService {
  #usersById = new Map<string, User>();
  #usersByUsername = new Map<string, User>();
  #sessions = new Map<string, Session>();
  #systemApiKey: SystemApiKeyRecord | undefined;

  hasAnyUsers(): boolean {
    return this.#usersById.size > 0;
  }

  /** Creates a login-capable account. Never overwrites an existing username. */
  createUser(params: { username: string; password: string; role: UserRole; actorId?: string }): User {
    const key = params.username.trim().toLowerCase();
    if (!key) throw new AuthError("username must not be empty");
    if (params.password.length < 8) throw new AuthError("password must be at least 8 characters");
    if (this.#usersByUsername.has(key)) {
      throw new AuthError(`username '${params.username}' already exists`);
    }
    const salt = randomBytes(16).toString("hex");
    const user: User = {
      id: nextUserId(),
      username: params.username,
      passwordHash: hashSecret(params.password, salt),
      salt,
      role: params.role,
      actorId: params.actorId ?? params.username,
      disabled: false,
    };
    this.#usersById.set(user.id, user);
    this.#usersByUsername.set(key, user);
    return user;
  }

  /**
   * Verifies credentials and issues a new session. Throws AuthError on any
   * mismatch — a disabled account fails with the exact same message as a
   * wrong password, so probing a username never reveals whether it exists
   * or has been disabled.
   */
  login(username: string, password: string, remember: boolean): Session {
    const user = this.#usersByUsername.get(username.trim().toLowerCase());
    if (!user || user.disabled || !timingSafeStringEqual(hashSecret(password, user.salt), user.passwordHash)) {
      throw new AuthError("invalid username or password");
    }
    const now = Date.now();
    const ttl = remember ? REMEMBER_SESSION_TTL_MS : DEFAULT_SESSION_TTL_MS;
    const session: Session = {
      token: randomBytes(32).toString("hex"),
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
      remember,
    };
    this.#sessions.set(session.token, session);
    return session;
  }

  logout(token: string): void {
    this.#sessions.delete(token);
  }

  /** Every account, including disabled ones — for an attorney-facing account-management view. Never exposed unfiltered over the wire; callers must drop passwordHash/salt themselves (see AccountsService). */
  listUsers(): User[] {
    return [...this.#usersById.values()].map((u) => ({ ...u }));
  }

  /**
   * Enables or disables an account. Disabling revokes every one of that
   * user's live sessions immediately — including "remember me" ones — so
   * access is cut off the moment an attorney acts, not the next time the
   * session would otherwise have been checked. Refuses to disable the
   * last remaining enabled attorney account, since that would leave
   * nobody able to run this — or any other attorney-only — surface.
   */
  setDisabled(userId: string, disabled: boolean): User {
    const user = this.#usersById.get(userId);
    if (!user) {
      throw new Error(`no user '${userId}'`);
    }
    if (disabled && user.role === "attorney") {
      const anotherEnabledAttorney = [...this.#usersById.values()].some(
        (u) => u.id !== userId && u.role === "attorney" && !u.disabled,
      );
      if (!anotherEnabledAttorney) {
        throw new Error(`cannot disable '${user.username}': at least one enabled attorney account must remain`);
      }
    }
    const updated: User = { ...user, disabled };
    this.#usersById.set(user.id, updated);
    this.#usersByUsername.set(user.username.trim().toLowerCase(), updated);
    if (disabled) {
      for (const [token, session] of this.#sessions) {
        if (session.userId === userId) this.#sessions.delete(token);
      }
    }
    return updated;
  }

  /** Resolves a session token to the {id, role} actor shape the rest of the system already speaks. Expired sessions are pruned on access. */
  actorForToken(token: string | undefined): { id: string; role: UserRole } | undefined {
    const session = this.#sessionForToken(token);
    if (!session) return undefined;
    const user = this.#usersById.get(session.userId);
    if (!user) return undefined;
    return { id: user.actorId, role: user.role };
  }

  /** Like actorForToken, but includes display fields (username) the dashboard needs and the Actor shape doesn't carry. */
  userForToken(token: string | undefined): User | undefined {
    const session = this.#sessionForToken(token);
    if (!session) return undefined;
    return this.#usersById.get(session.userId);
  }

  /**
   * The calendar integration's credential (§5's due-diligence item — no
   * real vendor is wired up yet, but this is the enforcement point that
   * will gate it once one is: a `calendar_system`-sourced deadline
   * confirmation must present this key, not just any attorney's session,
   * closing the "any string can call itself calendar_system" gap in
   * `core/deadline.ts`).
   */
  setSystemApiKey(rawKey: string): void {
    if (rawKey.length < 16) throw new AuthError("system API key must be at least 16 characters");
    const salt = randomBytes(16).toString("hex");
    this.#systemApiKey = { hash: hashSecret(rawKey, salt), salt };
  }

  hasSystemApiKey(): boolean {
    return this.#systemApiKey !== undefined;
  }

  verifySystemApiKey(rawKey: string | undefined): boolean {
    if (!rawKey || !this.#systemApiKey) return false;
    return timingSafeStringEqual(hashSecret(rawKey, this.#systemApiKey.salt), this.#systemApiKey.hash);
  }

  #sessionForToken(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.#sessions.get(token);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) < Date.now()) {
      this.#sessions.delete(token);
      return undefined;
    }
    return session;
  }

  toSnapshot(): AuthSnapshot {
    return {
      users: [...this.#usersById.values()].map((u) => ({ ...u })),
      sessions: [...this.#sessions.values()].map((s) => ({ ...s })),
      ...(this.#systemApiKey ? { systemApiKey: { ...this.#systemApiKey } } : {}),
    };
  }

  static fromSnapshot(snapshot: AuthSnapshot): AuthService {
    const service = new AuthService();
    for (const user of snapshot.users) {
      // `disabled` defaults to false for state files saved before this field existed.
      const restored: User = { ...user, disabled: user.disabled ?? false };
      service.#usersById.set(user.id, restored);
      service.#usersByUsername.set(user.username.trim().toLowerCase(), restored);
    }
    const now = Date.now();
    for (const session of snapshot.sessions) {
      if (Date.parse(session.expiresAt) >= now) {
        service.#sessions.set(session.token, { ...session });
      }
    }
    if (snapshot.systemApiKey) {
      service.#systemApiKey = { ...snapshot.systemApiKey };
    }
    return service;
  }
}
