import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AgentRole } from "./types.js";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp.js";

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
export type UserRole = AgentRole | "attorney" | "staff" | "client";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly salt: string;
  readonly role: UserRole;
  /** The Actor.id this user maps to for authorization checks (access-control, scheduling assignment, etc.). */
  readonly actorId: string;
  /** A person's full name, for the Staff directory/messaging/schedule panels — falls back to `username` if never set. */
  readonly displayName: string;
  /** Disabled accounts can never log in again and have every live session revoked immediately — see `setDisabled`. */
  readonly disabled: boolean;
  /** Set by `resetPassword()` (an attorney set a temporary password on this user's behalf); cleared by `changePassword()`. Surfaced via `/api/me` and the Accounts panel — there's no forced-change flow yet, just a flag the UI can nudge on. */
  readonly mustChangePassword: boolean;
  /** Present only once enrollment has been *confirmed* with a working code — see `confirmMfaEnrollment`. */
  readonly mfa?: MfaEnrollment;
  /** A secret generated but not yet proven to work. Never gates a login; replaced freely if enrollment is restarted. */
  readonly pendingMfaSecret?: string;
}

/** A recovery code, stored the same way a password is — the plaintext exists exactly once, at generation. */
export interface MfaRecoveryCode {
  readonly hash: string;
  readonly salt: string;
  readonly usedAt?: string;
}

export interface MfaEnrollment {
  /** Base32, as an authenticator app holds it. */
  readonly secret: string;
  readonly confirmedAt: string;
  /**
   * The last TOTP step accepted for this account. A code stays valid for
   * its whole 30-second window, so without this an intercepted code is
   * replayable until the window closes — see `verifyTotp`, which returns
   * the step for exactly this reason.
   */
  readonly lastUsedStep?: number;
  readonly recoveryCodes: MfaRecoveryCode[];
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

/**
 * The password was right and a second factor is now required.
 *
 * A distinct type rather than a flag on `AuthError` because the two
 * deserve opposite handling: a wrong password is a failed attempt and
 * counts against the login throttle, while this is the *normal* first
 * half of a two-step login and must not — otherwise five ordinary logins
 * would lock an attorney out of their own matters.
 *
 * It does disclose that the password was correct, which is unavoidable
 * in any two-step flow and is the point: the attacker still cannot get
 * in, which is what the second factor is for.
 */
export class MfaRequiredError extends AuthError {
  constructor(message = "authentication code required") {
    super(message);
    this.name = "MfaRequiredError";
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

/** How many recovery codes are issued at once. Ten is enough to lose a few and still have some. */
const RECOVERY_CODE_COUNT = 10;
/** Crockford-ish base32 minus the characters people confuse: no I/L/O/U/0/1. */
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * Recovery codes, printed once and stored hashed.
 *
 * Grouped `xxxx-xxxx-xxxx` because these get written on paper and read
 * back later, often by someone else over the phone, and 12 unbroken
 * characters is where transcription errors start. 60 bits of entropy
 * each — far beyond guessable, and the login throttle covers the rest.
 */
function generateRecoveryCodes(): { plaintext: string[]; stored: MfaRecoveryCode[] } {
  const plaintext: string[] = [];
  const stored: MfaRecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const chars = [...randomBytes(12)].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    const salt = randomBytes(16).toString("hex");
    plaintext.push(code);
    stored.push({ hash: hashSecret(code, salt), salt });
  }
  return { plaintext, stored };
}

/** Accepts what people actually type: lower case, missing or extra dashes, spaces. Returns `undefined` if it isn't code-shaped. */
function normalizeRecoveryCode(input: string): string | undefined {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (bare.length !== 12) return undefined;
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}`;
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
  createUser(params: { username: string; password: string; role: UserRole; actorId?: string; displayName?: string }): User {
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
      displayName: params.displayName?.trim() || params.username,
      disabled: false,
      mustChangePassword: false,
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
  login(username: string, password: string, remember: boolean, mfaCode?: string): Session {
    const user = this.#usersByUsername.get(username.trim().toLowerCase());
    if (!user || user.disabled || !timingSafeStringEqual(hashSecret(password, user.salt), user.passwordHash)) {
      throw new AuthError("invalid username or password");
    }
    if (user.mfa) {
      const supplied = mfaCode?.trim() ?? "";
      if (!supplied) throw new MfaRequiredError();
      this.#consumeSecondFactor(user, supplied);
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

  /**
   * Re-proves a logged-in user's password. Used by the routes that
   * weaken or replace a second factor: holding a session is not the same
   * as being at the keyboard, and a borrowed unlocked laptop shouldn't
   * be enough to strip the protection on the account. Throws rather than
   * returning false, so it can't be called and its result forgotten.
   */
  verifyPassword(userId: string, password: string): void {
    const user = this.#requireUser(userId);
    if (!timingSafeStringEqual(hashSecret(password, user.salt), user.passwordHash)) {
      throw new AuthError("current password is incorrect");
    }
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
      this.#revokeAllSessions(userId);
    }
    return updated;
  }

  /**
   * Attorney-initiated password reset (see `AccountsService.resetPassword`
   * for the actual attorney gate — this method just does the mechanical
   * work). Sets a new password chosen by the attorney, marks
   * `mustChangePassword` so the account holder is nudged to pick their own
   * on next login, and revokes every live session immediately — the same
   * "access changes take effect now, not next check" behavior as
   * `setDisabled`. There's still no email/token-based self-service reset
   * flow; this is attorney-to-user, in person or over some other secure
   * channel, matching this project's existing "no email verification, no
   * invite links" scope line for account management.
   */
  resetPassword(userId: string, newPassword: string): User {
    const user = this.#usersById.get(userId);
    if (!user) {
      throw new Error(`no user '${userId}'`);
    }
    if (newPassword.length < 8) throw new AuthError("password must be at least 8 characters");
    const updated = this.#applyNewPassword(user, newPassword, true);
    this.#revokeAllSessions(userId);
    return updated;
  }

  /**
   * Self-service password change — any logged-in user, any role. Requires
   * proving the *current* password first (unlike `resetPassword`, which is
   * an attorney overriding it without knowing it). Clears
   * `mustChangePassword` and, like every other credential change here,
   * revokes every live session — including the one making this request —
   * so the caller has to log back in with the new password rather than
   * silently keeping the old session alive.
   */
  changePassword(userId: string, currentPassword: string, newPassword: string): User {
    const user = this.#usersById.get(userId);
    if (!user) {
      throw new Error(`no user '${userId}'`);
    }
    if (!timingSafeStringEqual(hashSecret(currentPassword, user.salt), user.passwordHash)) {
      throw new AuthError("current password is incorrect");
    }
    if (newPassword.length < 8) throw new AuthError("password must be at least 8 characters");
    const updated = this.#applyNewPassword(user, newPassword, false);
    this.#revokeAllSessions(userId);
    return updated;
  }

  /* ------------------------------------------------------------------ *
   * Multi-factor authentication
   *
   * The system holds privileged client material — trust balances, case
   * files, the audit log — behind a single password, and a password is
   * the credential most likely to be phished, reused, or written on a
   * sticky note. TOTP is the second factor because it needs no vendor,
   * no phone network, and no per-message cost, and because every
   * authenticator app already speaks it.
   *
   * Two design rules drive the shape of the methods below:
   *
   * 1. **Enrollment is not switched on until a code has been proven to
   *    work.** Generating a secret and immediately requiring it locks
   *    out anyone who mistyped it into their app, misread the QR code,
   *    or whose phone clock is wrong — and the person locked out is
   *    exactly the person the firm needs able to log in.
   * 2. **A lost phone must not be a permanent lockout.** Recovery codes
   *    cover the ordinary case without anyone's help; an
   *    attorney-initiated reset (`disableMfa`) covers losing those too.
   *    Same reasoning as the login-throttle escape hatch: a security
   *    control that can permanently deny an attorney access to their own
   *    matters has become the attack.
   * ------------------------------------------------------------------ */

  /**
   * Starts enrollment: generates a secret and returns it plus the
   * `otpauth://` URI for a QR code. Deliberately does **not** enable
   * anything — see rule 1 above. Calling it again simply replaces the
   * pending secret, so restarting a half-finished enrollment is safe.
   *
   * Requires the current password, the same as `disableMfa`/
   * `regenerateRecoveryCodes` — a session alone must not be enough to
   * *plant* a factor either, not just to strip one. Without this, a
   * briefly hijacked or unattended session (most accounts have no MFA
   * yet, since enrollment is voluntary) could silently enroll a secret
   * only the attacker holds, then rely on the victim never producing a
   * code and needing an attorney's `resetMfa` to get back in — a quiet,
   * durable foothold rather than a one-off theft.
   *
   * Refuses if MFA is already confirmed: re-enrolling would silently
   * invalidate the working authenticator entry, so that path has to go
   * through a disable first.
   */
  beginMfaEnrollment(userId: string, password: string, options: { issuer?: string } = {}): { secret: string; uri: string } {
    const user = this.#requireUser(userId);
    this.verifyPassword(userId, password);
    if (user.mfa) throw new AuthError("two-factor authentication is already enabled for this account");
    const secret = generateTotpSecret();
    this.#replaceUser({ ...user, pendingMfaSecret: secret });
    return { secret, uri: totpUri({ secret, account: user.username, issuer: options.issuer ?? "Docket" }) };
  }

  /**
   * Finishes enrollment once the account holder has typed a code their
   * app produced. Returns the recovery codes **in plaintext, once** —
   * they are stored hashed, exactly like passwords, so there is no way
   * to show them again later. `regenerateRecoveryCodes` issues a fresh
   * set for anyone who didn't write them down.
   *
   * Does **not** re-check the password: `beginMfaEnrollment` already
   * did, and by design nothing about `pendingMfaSecret` widens what an
   * attacker who merely holds the session (without the password) could
   * do — it isn't live until this call succeeds with a code from the
   * *same* secret, which the password check already gated.
   */
  confirmMfaEnrollment(userId: string, code: string): { recoveryCodes: string[] } {
    const user = this.#requireUser(userId);
    if (user.mfa) throw new AuthError("two-factor authentication is already enabled for this account");
    if (!user.pendingMfaSecret) throw new AuthError("start enrollment before confirming it");
    const step = verifyTotp(user.pendingMfaSecret, code);
    if (step === undefined) {
      throw new AuthError("that code isn't valid — check your authenticator app's clock and try the current code");
    }
    const { plaintext, stored } = generateRecoveryCodes();
    const { pendingMfaSecret: _pending, ...rest } = user;
    this.#replaceUser({
      ...rest,
      mfa: {
        secret: user.pendingMfaSecret,
        confirmedAt: new Date().toISOString(),
        lastUsedStep: step,
        recoveryCodes: stored,
      },
    });
    return { recoveryCodes: plaintext };
  }

  /**
   * Turns MFA off. Mechanical only — the two callers gate it very
   * differently (`AccountsService` requires an attorney and audits it
   * loudly, since it is a real bypass of someone else's second factor;
   * self-service disabling requires the current password), and every
   * live session is revoked either way so a stolen session can't
   * outlive the change.
   */
  disableMfa(userId: string): User {
    const user = this.#requireUser(userId);
    const { mfa: _mfa, pendingMfaSecret: _pending, ...rest } = user;
    const updated = this.#replaceUser(rest);
    this.#revokeAllSessions(userId);
    return updated;
  }

  /** A fresh set of recovery codes, invalidating the old ones. Plaintext returned once. */
  regenerateRecoveryCodes(userId: string): string[] {
    const user = this.#requireUser(userId);
    if (!user.mfa) throw new AuthError("two-factor authentication is not enabled for this account");
    const { plaintext, stored } = generateRecoveryCodes();
    this.#replaceUser({ ...user, mfa: { ...user.mfa, recoveryCodes: stored } });
    return plaintext;
  }

  /** Whether a second factor is required at login, plus how many recovery codes remain unused. */
  mfaStatus(userId: string): { enabled: boolean; enrollmentPending: boolean; recoveryCodesRemaining: number } {
    const user = this.#requireUser(userId);
    return {
      enabled: user.mfa !== undefined,
      enrollmentPending: user.pendingMfaSecret !== undefined && user.mfa === undefined,
      recoveryCodesRemaining: (user.mfa?.recoveryCodes ?? []).filter((c) => !c.usedAt).length,
    };
  }

  /**
   * Accepts a TOTP code or a recovery code, and *spends* it: a TOTP step
   * is recorded so the same code can't be replayed inside its window,
   * and a recovery code is marked used so it works exactly once. Both
   * writes happen before this returns, so a caller that ignores the
   * result still can't be replayed against.
   */
  #consumeSecondFactor(user: User, supplied: string): void {
    const enrollment = user.mfa;
    if (!enrollment) return;

    const step = verifyTotp(enrollment.secret, supplied);
    if (step !== undefined) {
      if (enrollment.lastUsedStep !== undefined && step <= enrollment.lastUsedStep) {
        throw new AuthError("that code has already been used — wait for your app to show the next one");
      }
      this.#replaceUser({ ...user, mfa: { ...enrollment, lastUsedStep: step } });
      return;
    }

    const normalized = normalizeRecoveryCode(supplied);
    if (normalized) {
      const codes = enrollment.recoveryCodes;
      const index = codes.findIndex((c) => !c.usedAt && timingSafeStringEqual(hashSecret(normalized, c.salt), c.hash));
      if (index !== -1) {
        const spent = codes.map((c, i) => (i === index ? { ...c, usedAt: new Date().toISOString() } : c));
        this.#replaceUser({ ...user, mfa: { ...enrollment, recoveryCodes: spent } });
        return;
      }
    }

    throw new AuthError("invalid authentication code");
  }

  #requireUser(userId: string): User {
    const user = this.#usersById.get(userId);
    if (!user) throw new Error(`no user '${userId}'`);
    return user;
  }

  /** Keeps the two indexes in step — they hold the same object, and half an update is a security bug. */
  #replaceUser(user: User): User {
    this.#usersById.set(user.id, user);
    this.#usersByUsername.set(user.username.trim().toLowerCase(), user);
    return user;
  }

  #applyNewPassword(user: User, newPassword: string, mustChangePassword: boolean): User {
    const salt = randomBytes(16).toString("hex");
    const updated: User = { ...user, passwordHash: hashSecret(newPassword, salt), salt, mustChangePassword };
    this.#usersById.set(user.id, updated);
    this.#usersByUsername.set(user.username.trim().toLowerCase(), updated);
    return updated;
  }

  #revokeAllSessions(userId: string): void {
    for (const [token, session] of this.#sessions) {
      if (session.userId === userId) this.#sessions.delete(token);
    }
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
      // `disabled`/`mustChangePassword` default to false for state files saved before these fields existed.
      const restored: User = {
        ...user,
        disabled: user.disabled ?? false,
        mustChangePassword: user.mustChangePassword ?? false,
        displayName: user.displayName || user.username,
      };
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
