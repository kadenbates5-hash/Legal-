import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpUri, verifyTotp } from "../src/core/totp.js";

/**
 * The point of these first two tests is that "does this implement the
 * standard" is answerable, not a matter of trust. The vectors are RFC
 * 6238 Appendix B's own, verbatim — if this file passes, an
 * authenticator app will agree with us.
 */
describe("RFC 6238 test vectors", () => {
  // The RFC's SHA-1 seed is the ASCII "12345678901234567890".
  const seed = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];

  for (const [unixSeconds, expected] of vectors) {
    it(`produces ${expected} at T=${unixSeconds}`, () => {
      expect(totpCode(seed, unixSeconds * 1000)).toBe(expected);
    });
  }
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 128, 64]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("accepts the shapes people paste: lower case, spaces, padding", () => {
    const secret = generateTotpSecret();
    const mangled = ` ${secret.toLowerCase().replace(/(.{4})/g, "$1 ")}== `;
    expect(base32Decode(mangled).equals(base32Decode(secret))).toBe(true);
  });

  it("rejects characters that aren't base32", () => {
    expect(() => base32Decode("ABC!")).toThrow(/not valid base32/);
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();
  const at = 1_700_000_000_000;

  it("accepts the current code and returns its step", () => {
    const step = verifyTotp(secret, totpCode(secret, at), { atMs: at });
    expect(step).toBe(Math.floor(at / 1000 / 30));
  });

  it("accepts one step of drift either way — a phone clock is never exact", () => {
    expect(verifyTotp(secret, totpCode(secret, at - 30_000), { atMs: at })).toBeDefined();
    expect(verifyTotp(secret, totpCode(secret, at + 30_000), { atMs: at })).toBeDefined();
  });

  it("rejects beyond the drift window", () => {
    expect(verifyTotp(secret, totpCode(secret, at - 90_000), { atMs: at })).toBeUndefined();
    expect(verifyTotp(secret, totpCode(secret, at + 90_000), { atMs: at })).toBeUndefined();
  });

  it("rejects anything that isn't six digits, without touching the secret", () => {
    for (const junk of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(secret, junk, { atMs: at })).toBeUndefined();
    }
  });

  it("rejects another account's code", () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(other, at), { atMs: at })).toBeUndefined();
  });
});

describe("totpUri", () => {
  it("carries the issuer in both places apps read it from", () => {
    const uri = totpUri({ secret: "ABCD", account: "dana@firm.example", issuer: "Ruiz & Partners" });
    expect(uri.startsWith("otpauth://totp/Ruiz%20%26%20Partners:dana%40firm.example?")).toBe(true);
    expect(uri).toContain("issuer=Ruiz+%26+Partners");
    expect(uri).toContain("secret=ABCD");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
