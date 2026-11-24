import { createHash, timingSafeEqual } from "node:crypto";

/**
 * How a long random bearer token — a signing link, a password-reset link —
 * is stored and checked.
 *
 * These tokens are 192 random bits, so a slow, salted hash (scrypt) adds
 * nothing: there is nothing to brute-force. What scrypt did add was cost
 * at the worst place. Finding the record for a presented token meant
 * hashing it once per *candidate* record, because each had its own salt,
 * and `scryptSync` blocks the whole process while it runs. A request for
 * `/api/sign/<anything>` — public, no sign-in — took 1.5 seconds of
 * blocked server with 30 signatures outstanding, so a few requests a
 * second kept Docket unresponsive for everyone. One SHA-256 of the
 * presented token, compared against each stored digest, costs
 * microseconds however many records there are.
 *
 * Passwords keep scrypt: they are chosen by people and are guessable,
 * which is what a slow hash is for.
 */
export function bearerTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Timing-safe equality of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Every bearer token Docket issues is 48 lowercase hex characters
 * (`randomBytes(24)`). A presented value of any other shape can't be one,
 * so it is turned away before any hashing — the cheapest possible answer
 * to someone sending garbage.
 */
export function looksLikeBearerToken(value: string): boolean {
  return /^[0-9a-f]{48}$/.test(value);
}
