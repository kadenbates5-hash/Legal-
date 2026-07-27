import { describe, expect, it } from "vitest";
import { AuthService, AuthError, MfaRequiredError } from "../src/core/auth.js";
import { totpCode } from "../src/core/totp.js";
import { AccessControl } from "../src/core/access-control.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { AuditLog } from "../src/core/audit.js";
import type { Actor } from "../src/core/types.js";

function enrolledUser(): { auth: AuthService; userId: string; secret: string; recoveryCodes: string[] } {
  const auth = new AuthService();
  const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
  const { secret } = auth.beginMfaEnrollment(user.id, "correct-horse");
  // Enrolls with the *previous* window's code (accepted, within drift) so
  // the current one is still unspent and the tests below can log in with
  // it — see "spends the code used to enroll" for why that matters.
  const { recoveryCodes } = auth.confirmMfaEnrollment(user.id, totpCode(secret, Date.now() - 30_000));
  return { auth, userId: user.id, secret, recoveryCodes };
}

describe("enrollment", () => {
  it("does not require a second factor until enrollment is confirmed", () => {
    const auth = new AuthService();
    const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
    auth.beginMfaEnrollment(user.id, "correct-horse");

    // The whole point of the two-step enrollment: generating a secret
    // must not lock out someone who mistyped it into their app.
    expect(() => auth.login("dana", "correct-horse", false)).not.toThrow();
    expect(auth.mfaStatus(user.id)).toMatchObject({ enabled: false, enrollmentPending: true });
  });

  it("refuses to confirm with a code the secret didn't produce", () => {
    const auth = new AuthService();
    const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
    auth.beginMfaEnrollment(user.id, "correct-horse");
    expect(() => auth.confirmMfaEnrollment(user.id, "000000")).toThrow(/isn't valid/);
    expect(auth.mfaStatus(user.id).enabled).toBe(false);
  });

  it("refuses to confirm without starting", () => {
    const auth = new AuthService();
    const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
    expect(() => auth.confirmMfaEnrollment(user.id, "000000")).toThrow(/start enrollment/);
  });

  it("refuses to start enrollment without the current password — a session alone must not be enough to plant a factor", () => {
    const auth = new AuthService();
    const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
    expect(() => auth.beginMfaEnrollment(user.id, "wrong")).toThrow(/current password is incorrect/);
    expect(auth.mfaStatus(user.id).enrollmentPending).toBe(false);
  });

  it("refuses to re-enroll over a working second factor", () => {
    const { auth, userId } = enrolledUser();
    expect(() => auth.beginMfaEnrollment(userId, "correct-horse")).toThrow(/already enabled/);
  });

  it("spends the code used to enroll, so it can't then be used to log in", () => {
    const auth = new AuthService();
    const user = auth.createUser({ username: "dana", password: "correct-horse", role: "attorney" });
    const { secret } = auth.beginMfaEnrollment(user.id, "correct-horse");
    const code = totpCode(secret);
    auth.confirmMfaEnrollment(user.id, code);
    expect(() => auth.login("dana", "correct-horse", false, code)).toThrow(/already been used/);
  });

  it("issues ten recovery codes, in the shape people transcribe", () => {
    const { auth, userId, recoveryCodes } = enrolledUser();
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(auth.mfaStatus(userId).recoveryCodesRemaining).toBe(10);
  });
});

describe("login", () => {
  it("asks for a code once enrolled, and distinguishes that from a bad password", () => {
    const { auth } = enrolledUser();
    expect(() => auth.login("dana", "correct-horse", false)).toThrow(MfaRequiredError);
    // A wrong password is NOT an MFA challenge — the login throttle
    // relies on being able to tell these apart.
    const wrong = (() => {
      try {
        auth.login("dana", "wrong", false);
      } catch (err) {
        return err;
      }
    })();
    expect(wrong).toBeInstanceOf(AuthError);
    expect(wrong).not.toBeInstanceOf(MfaRequiredError);
  });

  it("accepts a current code", () => {
    const { auth, secret } = enrolledUser();
    expect(auth.login("dana", "correct-horse", false, totpCode(secret)).token).toBeTruthy();
  });

  it("refuses to replay a code inside its own window", () => {
    const { auth, secret } = enrolledUser();
    const code = totpCode(secret);
    auth.login("dana", "correct-horse", false, code);
    // Same code, still valid by the clock — and that is exactly the
    // window an intercepted code would be replayed in.
    expect(() => auth.login("dana", "correct-horse", false, code)).toThrow(/already been used/);
  });

  it("rejects a wrong code even with the right password", () => {
    const { auth } = enrolledUser();
    expect(() => auth.login("dana", "correct-horse", false, "000000")).toThrow(/invalid authentication code/);
  });
});

describe("recovery codes", () => {
  it("logs in with one, and spends it", () => {
    const { auth, userId, recoveryCodes } = enrolledUser();
    const code = recoveryCodes[0]!;
    expect(auth.login("dana", "correct-horse", false, code).token).toBeTruthy();
    expect(auth.mfaStatus(userId).recoveryCodesRemaining).toBe(9);
    expect(() => auth.login("dana", "correct-horse", false, code)).toThrow(/invalid authentication code/);
  });

  it("accepts the sloppy transcription a phone call produces", () => {
    const { auth, recoveryCodes } = enrolledUser();
    const messy = ` ${recoveryCodes[0]!.toLowerCase().replace(/-/g, " ")} `;
    expect(auth.login("dana", "correct-horse", false, messy).token).toBeTruthy();
  });

  it("regenerating invalidates the old set", () => {
    const { auth, userId, recoveryCodes } = enrolledUser();
    const fresh = auth.regenerateRecoveryCodes(userId);
    expect(fresh).toHaveLength(10);
    expect(() => auth.login("dana", "correct-horse", false, recoveryCodes[0]!)).toThrow(/invalid/);
    expect(auth.login("dana", "correct-horse", false, fresh[0]!).token).toBeTruthy();
  });
});

describe("disabling", () => {
  it("returns the account to password-only and revokes live sessions", () => {
    const { auth, userId, secret } = enrolledUser();
    const session = auth.login("dana", "correct-horse", false, totpCode(secret));
    auth.disableMfa(userId);

    // A session minted under the stronger factor must not survive the
    // factor being removed.
    expect(auth.actorForToken(session.token)).toBeUndefined();
    expect(auth.login("dana", "correct-horse", false).token).toBeTruthy();
  });

  it("requires the current password to disable self-service", () => {
    const { auth, userId } = enrolledUser();
    expect(() => auth.verifyPassword(userId, "nope")).toThrow(/current password is incorrect/);
    expect(() => auth.verifyPassword(userId, "correct-horse")).not.toThrow();
  });
});

describe("attorney-initiated reset", () => {
  const attorney: Actor = { id: "att-1", role: "attorney" };

  function accountsFor(auth: AuthService, auditLog: AuditLog): AccountsService {
    return new AccountsService(auth, new AccessControl(auditLog), undefined, auditLog);
  }

  it("clears someone else's second factor and says so loudly in the log", () => {
    const { auth, userId } = enrolledUser();
    const auditLog = new AuditLog();
    const summary = accountsFor(auth, auditLog).resetMfa(attorney, userId);

    expect(summary.mfaEnabled).toBe(false);
    const entry = auditLog.read("attorney").find((e) => e.action === "account_mfa_reset");
    expect(entry?.actor.id).toBe("att-1");
    expect(entry?.detail).toContain("wasEnabled=true");
  });

  it("is attorney-only — the whole point is that it is a bypass", () => {
    const { auth, userId } = enrolledUser();
    const accounts = accountsFor(auth, new AuditLog());
    expect(() => accounts.resetMfa({ id: "p-1", role: "paralegal" }, userId)).toThrow(/attorney-only/);
    expect(auth.mfaStatus(userId).enabled).toBe(true);
  });

  it("reports enrollment state in the account list without exposing the secret", () => {
    const { auth, userId } = enrolledUser();
    const summary = accountsFor(auth, new AuditLog()).list(attorney).find((a) => a.id === userId);
    expect(summary).toMatchObject({ mfaEnabled: true, recoveryCodesRemaining: 10 });
    expect(JSON.stringify(summary)).not.toContain(auth.listUsers()[0]!.mfa!.secret);
  });
});

describe("persistence", () => {
  it("survives a restart — otherwise a reboot silently drops everyone's second factor", () => {
    const { auth, userId, secret, recoveryCodes } = enrolledUser();
    auth.login("dana", "correct-horse", false, recoveryCodes[0]!);

    const restored = AuthService.fromSnapshot(JSON.parse(JSON.stringify(auth.toSnapshot())));
    expect(restored.mfaStatus(userId)).toMatchObject({ enabled: true, recoveryCodesRemaining: 9 });
    expect(() => restored.login("dana", "correct-horse", false)).toThrow(MfaRequiredError);
    expect(restored.login("dana", "correct-horse", false, totpCode(secret)).token).toBeTruthy();
    // The spent recovery code is still spent on the other side.
    expect(() => restored.login("dana", "correct-horse", false, recoveryCodes[0]!)).toThrow(/invalid/);
  });

  it("an account saved before MFA existed simply has none", () => {
    const auth = new AuthService();
    auth.createUser({ username: "old", password: "correct-horse", role: "paralegal" });
    const snapshot = auth.toSnapshot();
    const restored = AuthService.fromSnapshot(snapshot);
    expect(restored.mfaStatus(restored.listUsers()[0]!.id).enabled).toBe(false);
  });
});
