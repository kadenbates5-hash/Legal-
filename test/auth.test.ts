import { describe, expect, it, vi } from "vitest";
import { AuthError, AuthService } from "../src/core/auth.js";

describe("AuthService", () => {
  it("logs in with correct credentials and resolves the session to an actor", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });

    const session = auth.login("alice", "correct-horse", false);
    expect(auth.actorForToken(session.token)).toEqual({ id: "a1", role: "attorney" });
  });

  it("rejects an unknown username and a wrong password identically (no user-enumeration signal)", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney" });

    let unknownUserError: string | undefined;
    let wrongPasswordError: string | undefined;
    try {
      auth.login("bob", "whatever", false);
    } catch (err) {
      unknownUserError = (err as Error).message;
    }
    try {
      auth.login("alice", "wrong-password", false);
    } catch (err) {
      wrongPasswordError = (err as Error).message;
    }
    expect(unknownUserError).toBe(wrongPasswordError);
    expect(unknownUserError).toMatch(/invalid username or password/);
  });

  it("is case-insensitive on username but exact on password", () => {
    const auth = new AuthService();
    auth.createUser({ username: "Alice", password: "correct-horse", role: "attorney" });
    expect(() => auth.login("alice", "correct-horse", false)).not.toThrow();
    expect(() => auth.login("ALICE", "correct-horse", false)).not.toThrow();
    expect(() => auth.login("alice", "Correct-Horse", false)).toThrow(AuthError);
  });

  it("refuses to create a duplicate username", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney" });
    expect(() => auth.createUser({ username: "alice", password: "another-pass", role: "paralegal" })).toThrow(AuthError);
  });

  it("refuses a password shorter than 8 characters", () => {
    const auth = new AuthService();
    expect(() => auth.createUser({ username: "alice", password: "short", role: "attorney" })).toThrow(AuthError);
  });

  it("expires a default (non-remembered) session after its TTL", () => {
    vi.useFakeTimers();
    try {
      const auth = new AuthService();
      auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });
      const session = auth.login("alice", "correct-horse", false);
      expect(auth.actorForToken(session.token)).toBeDefined();

      vi.advanceTimersByTime(13 * 60 * 60 * 1000); // 13h > 12h default TTL
      expect(auth.actorForToken(session.token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 'remember me' session outlives the default TTL", () => {
    vi.useFakeTimers();
    try {
      const auth = new AuthService();
      auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });
      const session = auth.login("alice", "correct-horse", true);

      vi.advanceTimersByTime(13 * 60 * 60 * 1000); // past the non-remembered TTL
      expect(auth.actorForToken(session.token)).toBeDefined();

      vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // past the 30-day remember TTL
      expect(auth.actorForToken(session.token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logout invalidates the session immediately", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });
    const session = auth.login("alice", "correct-horse", false);
    expect(auth.actorForToken(session.token)).toBeDefined();

    auth.logout(session.token);
    expect(auth.actorForToken(session.token)).toBeUndefined();
  });

  it("returns undefined for a bogus or missing token, never throws", () => {
    const auth = new AuthService();
    expect(auth.actorForToken(undefined)).toBeUndefined();
    expect(auth.actorForToken("not-a-real-token")).toBeUndefined();
  });

  it("verifies the system API key with a timing-safe comparison, and rejects wrong/missing keys", () => {
    const auth = new AuthService();
    auth.setSystemApiKey("a-real-calendar-integration-key");
    expect(auth.verifySystemApiKey("a-real-calendar-integration-key")).toBe(true);
    expect(auth.verifySystemApiKey("wrong-key-of-different-length")).toBe(false);
    expect(auth.verifySystemApiKey(undefined)).toBe(false);
  });

  it("refuses a system API key shorter than 16 characters", () => {
    const auth = new AuthService();
    expect(() => auth.setSystemApiKey("short")).toThrow(AuthError);
  });

  it("round-trips users, live sessions, and the system key through a snapshot", () => {
    const auth = new AuthService();
    auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });
    const session = auth.login("alice", "correct-horse", true);
    auth.setSystemApiKey("a-real-calendar-integration-key");

    const restored = AuthService.fromSnapshot(auth.toSnapshot());
    expect(restored.actorForToken(session.token)).toEqual({ id: "a1", role: "attorney" });
    expect(restored.verifySystemApiKey("a-real-calendar-integration-key")).toBe(true);
    expect(restored.hasAnyUsers()).toBe(true);
  });

  it("drops already-expired sessions when rehydrating from a snapshot", () => {
    vi.useFakeTimers();
    try {
      const auth = new AuthService();
      auth.createUser({ username: "alice", password: "correct-horse", role: "attorney", actorId: "a1" });
      const session = auth.login("alice", "correct-horse", false);
      vi.advanceTimersByTime(13 * 60 * 60 * 1000);
      const snapshot = auth.toSnapshot(); // captures the (now-expired) session as-is

      const restored = AuthService.fromSnapshot(snapshot);
      expect(restored.actorForToken(session.token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
