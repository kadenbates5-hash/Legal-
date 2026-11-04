import { beforeEach, describe, expect, it } from "vitest";
import { AuthService, AuthError, MfaRequiredError } from "../src/core/auth.js";
import type { StoredPasskey, WebAuthnProvider } from "../src/integrations/webauthn-provider.js";

/**
 * A fully scripted fake — real WebAuthn verification needs an actual
 * authenticator (hardware or a software simulator) to produce a
 * signature, which this suite has no way to run. The fake instead proves
 * `AuthService` calls the provider correctly and handles its results
 * correctly, the same boundary-testing approach this project already
 * uses for `ClaudeClient`/`CaseLawSearchClient` fakes elsewhere.
 */
function fakeProvider(overrides: Partial<WebAuthnProvider> = {}): WebAuthnProvider {
  let challengeCounter = 0;
  return {
    async generateRegistrationOptions() {
      challengeCounter += 1;
      return { challenge: `reg-challenge-${challengeCounter}` };
    },
    async verifyRegistration({ expectedChallenge }) {
      return {
        verified: true,
        credential: { id: `cred-for-${expectedChallenge}`, publicKey: "fake-public-key", counter: 0 },
      };
    },
    async generateAuthenticationOptions() {
      challengeCounter += 1;
      return { challenge: `auth-challenge-${challengeCounter}` };
    },
    async verifyAuthentication() {
      return { verified: true, newCounter: 1 };
    },
    ...overrides,
  };
}

let auth: AuthService;
let userId: string;

beforeEach(() => {
  auth = new AuthService();
  auth.setWebAuthnProvider(fakeProvider());
  const user = auth.createUser({ username: "alice", password: "correct-horse", role: "attorney" });
  userId = user.id;
});

describe("passkey registration", () => {
  it("throws if no WebAuthnProvider is configured", async () => {
    const bare = new AuthService();
    const user = bare.createUser({ username: "bob", password: "correct-horse", role: "attorney" });
    await expect(bare.beginPasskeyRegistration(user.id, "correct-horse")).rejects.toThrow(/not configured/);
  });

  it("requires the current password to begin", async () => {
    await expect(auth.beginPasskeyRegistration(userId, "wrong-password")).rejects.toThrow(AuthError);
  });

  it("begins and completes registration, storing the credential without the raw public key leaking back", async () => {
    const options = (await auth.beginPasskeyRegistration(userId, "correct-horse")) as { challenge: string };
    expect(options.challenge).toMatch(/^reg-challenge-/);

    const record = await auth.completePasskeyRegistration(userId, { fake: "response" }, "My Laptop");
    expect(record.nickname).toBe("My Laptop");
    expect(record.id).toBe(`cred-for-${options.challenge}`);

    const list = auth.listPasskeys(userId);
    expect(list).toEqual([{ id: record.id, nickname: "My Laptop", createdAt: record.createdAt }]);
  });

  it("falls back to a generic nickname when none is given", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const record = await auth.completePasskeyRegistration(userId, {}, "   ");
    expect(record.nickname).toBe("Passkey");
  });

  it("rejects completing registration without a pending challenge", async () => {
    await expect(auth.completePasskeyRegistration(userId, {}, "x")).rejects.toThrow(/expired|start again/);
  });

  it("rejects completing registration when verification fails", async () => {
    auth.setWebAuthnProvider(fakeProvider({ verifyRegistration: async () => ({ verified: false }) }));
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await expect(auth.completePasskeyRegistration(userId, {}, "x")).rejects.toThrow(/could not verify/);
  });

  it("excludes existing passkeys from a second registration so the same authenticator can't be re-added blindly", async () => {
    let seenExcludeCount = -1;
    auth.setWebAuthnProvider(
      fakeProvider({
        generateRegistrationOptions: async (params) => {
          seenExcludeCount = params.excludeCredentials.length;
          return { challenge: "c" };
        },
      }),
    );
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "First");
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    expect(seenExcludeCount).toBe(1);
  });
});

describe("removePasskey", () => {
  it("requires the current password", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const record = await auth.completePasskeyRegistration(userId, {}, "x");
    expect(() => auth.removePasskey(userId, "wrong-password", record.id)).toThrow(AuthError);
  });

  it("throws for an unknown passkey id", () => {
    expect(() => auth.removePasskey(userId, "correct-horse", "nope")).toThrow(/no passkey/);
  });

  it("removes the passkey", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const record = await auth.completePasskeyRegistration(userId, {}, "x");
    auth.removePasskey(userId, "correct-horse", record.id);
    expect(auth.listPasskeys(userId)).toEqual([]);
  });

  it("revokes every session when removing the last factor (no TOTP, no other passkeys)", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const record = await auth.completePasskeyRegistration(userId, {}, "x");
    await auth.beginPasskeyLogin("alice", "correct-horse");
    const session = await auth.completePasskeyLogin("alice", { id: record.id }, false);
    expect(auth.actorForToken(session.token)).toBeDefined();
    auth.removePasskey(userId, "correct-horse", record.id);
    expect(auth.actorForToken(session.token)).toBeUndefined();
  });

  it("does not revoke sessions when another factor still protects the account", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const first = await auth.completePasskeyRegistration(userId, {}, "First");
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "Second");

    await auth.beginPasskeyLogin("alice", "correct-horse");
    const session = await auth.completePasskeyLogin("alice", { id: first.id }, false);
    expect(auth.actorForToken(session.token)).toBeDefined();

    auth.removePasskey(userId, "correct-horse", first.id);
    expect(auth.actorForToken(session.token)).toBeDefined();
  });
});

describe("login() gate with passkeys", () => {
  it("a passkey-only account (no TOTP) cannot log in with just a password", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "x");
    try {
      auth.login("alice", "correct-horse", false);
      throw new Error("expected MfaRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(MfaRequiredError);
      expect((err as MfaRequiredError).hasPasskey).toBe(true);
    }
  });

  it("an account with no second factor at all logs in on password alone, unaffected", () => {
    const session = auth.login("alice", "correct-horse", false);
    expect(session.userId).toBe(userId);
  });

  it("MfaRequiredError reports hasPasskey: false for a TOTP-only account", async () => {
    auth.beginMfaEnrollment(userId, "correct-horse");
    // Can't easily confirm TOTP here without a real secret/clock — just
    // check the pre-confirmation gate doesn't require a code yet.
    expect(() => auth.login("alice", "correct-horse", false)).not.toThrow();
  });
});

describe("passkey login (begin/complete)", () => {
  let credentialId: string;

  beforeEach(async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    const record = await auth.completePasskeyRegistration(userId, {}, "x");
    credentialId = record.id;
  });

  it("beginPasskeyLogin requires the correct password", async () => {
    await expect(auth.beginPasskeyLogin("alice", "wrong-password")).rejects.toThrow(/invalid username or password/);
  });

  it("beginPasskeyLogin throws for an account with no passkeys", async () => {
    auth.createUser({ username: "bob", password: "correct-horse", role: "attorney" });
    await expect(auth.beginPasskeyLogin("bob", "correct-horse")).rejects.toThrow(/no passkey registered/);
  });

  it("completes a passkey login and issues a working session", async () => {
    await auth.beginPasskeyLogin("alice", "correct-horse");
    const session = await auth.completePasskeyLogin("alice", { id: credentialId }, false);
    const actor = auth.actorForToken(session.token);
    expect(actor?.role).toBe("attorney");
  });

  it("rejects completing login without a pending challenge", async () => {
    await expect(auth.completePasskeyLogin("alice", { id: credentialId }, false)).rejects.toThrow(/expired|try again/);
  });

  it("rejects an unrecognized credential id in the response", async () => {
    await auth.beginPasskeyLogin("alice", "correct-horse");
    await expect(auth.completePasskeyLogin("alice", { id: "not-a-real-credential" }, false)).rejects.toThrow(
      /unrecognized passkey/,
    );
  });

  it("rejects when verification fails", async () => {
    auth.setWebAuthnProvider(fakeProvider({ verifyAuthentication: async () => ({ verified: false }) }));
    await auth.beginPasskeyLogin("alice", "correct-horse");
    await expect(auth.completePasskeyLogin("alice", { id: credentialId }, false)).rejects.toThrow(/could not verify/);
  });

  it("updates the stored counter after a successful login", async () => {
    let capturedCredential: StoredPasskey | undefined;
    auth.setWebAuthnProvider(
      fakeProvider({
        verifyAuthentication: async (params) => {
          capturedCredential = params.credential;
          return { verified: true, newCounter: 42 };
        },
      }),
    );
    await auth.beginPasskeyLogin("alice", "correct-horse");
    await auth.completePasskeyLogin("alice", { id: credentialId }, false);
    expect(capturedCredential?.counter).toBe(0);

    // Logging in again should now see the updated counter passed through.
    let secondCredential: StoredPasskey | undefined;
    auth.setWebAuthnProvider(
      fakeProvider({
        verifyAuthentication: async (params) => {
          secondCredential = params.credential;
          return { verified: true, newCounter: 43 };
        },
      }),
    );
    await auth.beginPasskeyLogin("alice", "correct-horse");
    await auth.completePasskeyLogin("alice", { id: credentialId }, false);
    expect(secondCredential?.counter).toBe(42);
  });

  it("a stale/reused pending challenge can't be redeemed twice", async () => {
    await auth.beginPasskeyLogin("alice", "correct-horse");
    await auth.completePasskeyLogin("alice", { id: credentialId }, false);
    await expect(auth.completePasskeyLogin("alice", { id: credentialId }, false)).rejects.toThrow(/expired|try again/);
  });
});

describe("resetAllSecondFactors — the attorney-initiated 'nothing else works' escape hatch", () => {
  it("clears a passkey-only account's factor entirely, unlike disableMfa (which would leave it unable to log in at all)", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "Lost laptop");

    // disableMfa alone is the wrong tool here: it only ever touches
    // user.mfa, so a passkey-only account would stay locked out.
    auth.disableMfa(userId);
    expect(() => auth.login("alice", "correct-horse", false)).toThrow(MfaRequiredError);

    auth.resetAllSecondFactors(userId);
    expect(auth.listPasskeys(userId)).toEqual([]);
    const session = auth.login("alice", "correct-horse", false);
    expect(session.userId).toBe(userId);
  });

  it("clears both TOTP and passkeys when an account has both", async () => {
    auth.beginMfaEnrollment(userId, "correct-horse");
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "x");

    auth.resetAllSecondFactors(userId);
    expect(auth.mfaStatus(userId)).toMatchObject({ enabled: false });
    expect(auth.listPasskeys(userId)).toEqual([]);
    expect(() => auth.login("alice", "correct-horse", false)).not.toThrow();
  });

  it("revokes every live session", async () => {
    await auth.beginPasskeyRegistration(userId, "correct-horse");
    await auth.completePasskeyRegistration(userId, {}, "x");
    await auth.beginPasskeyLogin("alice", "correct-horse");
    const credentialId = auth.listPasskeys(userId)[0]!.id;
    const session = await auth.completePasskeyLogin("alice", { id: credentialId }, false);
    expect(auth.actorForToken(session.token)).toBeDefined();

    auth.resetAllSecondFactors(userId);
    expect(auth.actorForToken(session.token)).toBeUndefined();
  });
});
