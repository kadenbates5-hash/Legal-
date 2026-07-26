/**
 * Brute-force protection for `POST /api/login`.
 *
 * Two problems this solves, not one. The obvious one is password
 * guessing: `AuthService.login` will happily verify an unlimited number
 * of attempts. The less obvious one is that every attempt runs `scrypt`
 * by design — deliberately expensive — so an unthrottled login endpoint
 * is also a CPU-exhaustion vector against this single-process server,
 * reachable without any credentials at all.
 *
 * Failures are counted against two independent keys:
 *  - the **username**, which stops someone hammering one account from
 *    many addresses, and
 *  - the **client IP**, which stops password-spraying one guess across
 *    many accounts from one address.
 *
 * Either key tripping its threshold locks the attempt out. A successful
 * login clears that username's failures (and its own IP's), so an
 * ordinary user who mistypes a few times and then gets it right is never
 * left in a penalty box.
 *
 * Deliberately *not* an account disable: a lockout is time-boxed and
 * self-healing, so an attacker can't use it to permanently deny a real
 * attorney access to their own matters — the same reasoning behind
 * `AuthService.setDisabled` refusing to remove the last enabled attorney.
 */
export interface LoginThrottleSnapshot {
  failures: { key: string; timestamps: string[] }[];
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the caller may try again — only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

/** Failures within this window count toward the threshold; older ones are forgotten. */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
/** Failures allowed within the window before the key is locked out. */
const DEFAULT_MAX_FAILURES = 5;
/** How long a key stays locked once it trips the threshold. */
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

export interface LoginThrottleOptions {
  windowMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
  /** Injectable clock, so tests don't have to sleep through a lockout. */
  now?: () => number;
}

export class LoginThrottle {
  #failures = new Map<string, number[]>();
  #windowMs: number;
  #maxFailures: number;
  #lockoutMs: number;
  #now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.#lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  static usernameKey(username: string): string {
    return `user:${username.trim().toLowerCase()}`;
  }

  static ipKey(ip: string): string {
    return `ip:${ip}`;
  }

  /**
   * Whether an attempt may proceed. Checked *before* the password is
   * verified, so a locked-out key never reaches `scrypt` — that's what
   * makes this a defense against the CPU cost and not just the guessing.
   */
  check(keys: readonly string[]): ThrottleDecision {
    let worstRetry = 0;
    for (const key of keys) {
      const recent = this.#recentFailures(key);
      if (recent.length >= this.#maxFailures) {
        const lockedUntil = recent[recent.length - 1]! + this.#lockoutMs;
        const remainingMs = lockedUntil - this.#now();
        if (remainingMs > 0) worstRetry = Math.max(worstRetry, Math.ceil(remainingMs / 1000));
      }
    }
    return worstRetry > 0 ? { allowed: false, retryAfterSeconds: worstRetry } : { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(keys: readonly string[]): void {
    const now = this.#now();
    for (const key of keys) {
      const recent = this.#recentFailures(key);
      recent.push(now);
      this.#failures.set(key, recent);
    }
  }

  /** Clears the counters for these keys — called on a successful login. */
  recordSuccess(keys: readonly string[]): void {
    for (const key of keys) this.#failures.delete(key);
  }

  /** Failures still inside the window, pruned in place so the map can't grow without bound. */
  #recentFailures(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const kept = (this.#failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, kept);
    return kept;
  }

  /**
   * Drops every key with no in-window failures. `#recentFailures` already
   * prunes lazily on access, but a key that's never checked again would
   * otherwise linger in a persisted snapshot forever.
   */
  prune(): void {
    for (const key of [...this.#failures.keys()]) this.#recentFailures(key);
  }

  toSnapshot(): LoginThrottleSnapshot {
    this.prune();
    return {
      failures: [...this.#failures.entries()].map(([key, timestamps]) => ({
        key,
        timestamps: timestamps.map((t) => new Date(t).toISOString()),
      })),
    };
  }

  static fromSnapshot(snapshot: LoginThrottleSnapshot, options: LoginThrottleOptions = {}): LoginThrottle {
    const throttle = new LoginThrottle(options);
    for (const entry of snapshot.failures ?? []) {
      const timestamps = entry.timestamps.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t));
      if (timestamps.length > 0) throttle.#failures.set(entry.key, timestamps);
    }
    throttle.prune();
    return throttle;
  }
}
