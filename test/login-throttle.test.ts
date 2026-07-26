import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../src/core/login-throttle.js";

/** Controllable clock so lockout expiry can be tested without sleeping. */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const KEYS = [LoginThrottle.usernameKey("Attorney1"), LoginThrottle.ipKey("10.0.0.1")];

describe("LoginThrottle", () => {
  it("allows attempts up to the threshold, then locks out", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 3, now: clock.now });
    for (let i = 0; i < 2; i++) {
      expect(throttle.check(KEYS).allowed).toBe(true);
      throttle.recordFailure(KEYS);
    }
    expect(throttle.check(KEYS).allowed).toBe(true);
    throttle.recordFailure(KEYS);
    const blocked = throttle.check(KEYS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("normalizes the username key so case and padding can't sidestep the counter", () => {
    expect(LoginThrottle.usernameKey("  ATTORNEY1 ")).toBe(LoginThrottle.usernameKey("attorney1"));
  });

  it("lets the lockout expire on its own — it is time-boxed, not an account disable", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 2, lockoutMs: 60_000, now: clock.now });
    throttle.recordFailure(KEYS);
    throttle.recordFailure(KEYS);
    expect(throttle.check(KEYS).allowed).toBe(false);
    clock.advance(60_001);
    expect(throttle.check(KEYS).allowed).toBe(true);
  });

  it("forgets failures older than the window rather than accumulating them forever", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 10_000, now: clock.now });
    throttle.recordFailure(KEYS);
    throttle.recordFailure(KEYS);
    clock.advance(10_001);
    throttle.recordFailure(KEYS);
    // The two old failures aged out, so this is the first in-window failure.
    expect(throttle.check(KEYS).allowed).toBe(true);
  });

  it("clears the counter on success", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 2, now: clock.now });
    throttle.recordFailure(KEYS);
    throttle.recordSuccess(KEYS);
    throttle.recordFailure(KEYS);
    expect(throttle.check(KEYS).allowed).toBe(true);
  });

  it("locks a username hammered from many different addresses", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 3, now: clock.now });
    const user = LoginThrottle.usernameKey("attorney1");
    for (let i = 0; i < 3; i++) throttle.recordFailure([user, LoginThrottle.ipKey(`10.0.0.${i}`)]);
    // A fresh address still can't get through: the username key is tripped.
    expect(throttle.check([user, LoginThrottle.ipKey("10.0.0.99")]).allowed).toBe(false);
  });

  it("locks one address spraying guesses across many usernames", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 3, now: clock.now });
    const ip = LoginThrottle.ipKey("10.0.0.1");
    for (const name of ["a", "b", "c"]) throttle.recordFailure([LoginThrottle.usernameKey(name), ip]);
    // A username never tried before is still blocked from that address.
    expect(throttle.check([LoginThrottle.usernameKey("untouched"), ip]).allowed).toBe(false);
  });

  it("survives a restart, so a lockout can't be cleared by bouncing the process", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ maxFailures: 2, now: clock.now });
    throttle.recordFailure(KEYS);
    throttle.recordFailure(KEYS);
    const restored = LoginThrottle.fromSnapshot(throttle.toSnapshot(), { maxFailures: 2, now: clock.now });
    expect(restored.check(KEYS).allowed).toBe(false);
  });

  it("drops fully-expired keys from the snapshot instead of growing without bound", () => {
    const clock = makeClock();
    const throttle = new LoginThrottle({ windowMs: 10_000, now: clock.now });
    throttle.recordFailure(KEYS);
    expect(throttle.toSnapshot().failures.length).toBeGreaterThan(0);
    clock.advance(10_001);
    expect(throttle.toSnapshot().failures).toHaveLength(0);
  });
});
