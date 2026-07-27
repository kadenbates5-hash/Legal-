import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP).
 *
 * Hand-rolled over `node:crypto` rather than pulling in a dependency,
 * matching this project's dependency-light style (`pg`, `pdf-parse` and
 * `pdf-lib` are the justified exceptions — reimplementing PDF parsing is
 * not a reasonable ask; a 60-line HMAC truncation is). The upside is not
 * just fewer packages: TOTP is exactly the kind of code that should be
 * readable by whoever has to trust it, and it's pinned here against the
 * published RFC 6238 test vectors, so "does this actually implement the
 * standard" is a question with a checkable answer rather than a
 * transitive-dependency question.
 *
 * Compatible with Google Authenticator, 1Password, Authy and anything
 * else that speaks `otpauth://totp/` — SHA-1, 6 digits, 30-second step.
 * Those parameters are the interoperable defaults, not a security
 * judgement: SHA-1 is weak as a collision-resistant hash and irrelevantly
 * so inside HMAC over a 30-second window, and authenticator apps in
 * practice ignore an `algorithm=SHA256` parameter or silently compute the
 * wrong code, which is a worse failure than the theoretical one.
 */

/** RFC 6238's default time step. */
export const TOTP_PERIOD_SECONDS = 30;
/** RFC 4226's recommended digit count, and what every authenticator app assumes. */
export const TOTP_DIGITS = 6;
/**
 * How many steps either side of "now" are accepted. One step (±30s)
 * absorbs the two things that actually happen: a phone clock a few
 * seconds off, and a person who starts typing a code with four seconds
 * left on it. Widening this multiplies the guessing surface for no
 * usability gain.
 */
export const TOTP_DRIFT_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the encoding every authenticator app expects a secret in. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of the shapes people paste: lower case, `=` padding, and the spaces apps insert every four characters. */
export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`'${char}' is not valid base32`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A fresh secret. 20 bytes is RFC 4226's recommended minimum and what
 * the HMAC-SHA1 block size makes natural; longer buys nothing here and
 * produces a QR code some readers struggle with.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 §5.3: HMAC the counter, then dynamically truncate. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const counterBytes = Buffer.alloc(8);
  // `writeBigUInt64BE` rather than two 32-bit writes: the counter is
  // fine in a double today and won't be in a few thousand years, but
  // getting the halves the wrong way round is a bug that only shows up
  // then, and there's no reason to write it.
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for a given moment. `atMs` is injectable so tests aren't wall-clock dependent. */
export function totpCode(
  secretBase32: string,
  atMs: number = Date.now(),
  options: { period?: number; digits?: number } = {},
): string {
  const period = options.period ?? TOTP_PERIOD_SECONDS;
  const digits = options.digits ?? TOTP_DIGITS;
  const counter = Math.floor(atMs / 1000 / period);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Whether `code` is valid right now, allowing for clock drift.
 *
 * Returns the matching **step number** rather than a boolean, because a
 * caller has to remember it: within one 30-second window the same code
 * stays valid, so an intercepted code is replayable until the window
 * ends unless the last accepted step is recorded and refused a second
 * time. Callers that don't care can treat `undefined` as failure.
 *
 * The comparison is constant-time. Timing on a 6-digit code is a thin
 * channel, but it's free to close.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { atMs?: number; period?: number; digits?: number; driftSteps?: number } = {},
): number | undefined {
  const period = options.period ?? TOTP_PERIOD_SECONDS;
  const digits = options.digits ?? TOTP_DIGITS;
  const drift = options.driftSteps ?? TOTP_DRIFT_STEPS;
  const atMs = options.atMs ?? Date.now();

  const candidate = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return undefined;

  const secret = base32Decode(secretBase32);
  const current = Math.floor(atMs / 1000 / period);
  // Every step in the window is checked even after a match, so the
  // number of HMACs computed doesn't depend on *which* step matched.
  let matched: number | undefined;
  for (let step = current - drift; step <= current + drift; step += 1) {
    const expected = hotp(secret, step, digits);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) matched = step;
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app scans as a QR code.
 *
 * `issuer` appears twice on purpose — as a label prefix and as a
 * parameter. Older apps read only the prefix, newer ones only the
 * parameter, and an app that shows a bare username with no firm name is
 * useless to anyone with more than one account.
 */
export function totpUri(params: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
