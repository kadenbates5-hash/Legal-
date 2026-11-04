import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

/**
 * A passkey as this project stores it — deliberately not the library's own
 * `WebAuthnCredential` type (same name, different shape): that one holds
 * the public key as raw bytes, which this project's single-JSON-blob
 * persistence model (see CLAUDE.md's "Persistence") can't carry directly.
 * `id`/`publicKey` are both base64url strings here so a `StoredPasskey`
 * round-trips through `toSnapshot()`/`fromSnapshot()` exactly like every
 * other stateful record in this codebase.
 */
export interface StoredPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

/**
 * Vendor-agnostic seam over WebAuthn verification, same pattern as
 * `ClaudeClient`/`CaseLawSearchClient`/`SpeechToText` elsewhere in this
 * directory — `core/auth.ts` depends on this interface only, never on
 * `@simplewebauthn/server` directly, so a fake implementation drives real
 * unit tests without a software-authenticator simulator. The opaque
 * `unknown` options/response payloads mirror `SpeechToText`'s opaque audio
 * type: this layer doesn't know or care about the exact JSON shape
 * `navigator.credentials.create()`/`.get()` produce, only that whatever
 * the browser returns gets handed back unchanged.
 *
 * The two `verify*` methods never reject — a malformed or hostile
 * response always resolves `{ verified: false }`, never throws. This is
 * load-bearing, not incidental: `@simplewebauthn/server` itself *does*
 * throw on malformed input (confirmed live against a garbage response),
 * so `SimpleWebAuthnProvider` below catches that and normalizes it,
 * keeping `AuthService` free of a try/catch around every call and
 * ensuring a bad request surfaces as a clean `AuthError`, never an
 * uncaught exception at the HTTP layer.
 */
export interface WebAuthnProvider {
  generateRegistrationOptions(params: {
    userId: string;
    username: string;
    displayName: string;
    excludeCredentials: StoredPasskey[];
  }): Promise<unknown>;

  verifyRegistration(params: { response: unknown; expectedChallenge: string }): Promise<
    { verified: false } | { verified: true; credential: StoredPasskey }
  >;

  generateAuthenticationOptions(params: { allowCredentials: StoredPasskey[] }): Promise<unknown>;

  verifyAuthentication(params: { response: unknown; expectedChallenge: string; credential: StoredPasskey }): Promise<
    { verified: false } | { verified: true; newCounter: number }
  >;
}

/**
 * The real implementation, over `@simplewebauthn/server` — a justified
 * dependency exception to this project's dependency-light style, same
 * reasoning as `pdf-parse`/`pdf-lib`/`pg`: correctly verifying a WebAuthn
 * attestation/assertion means parsing CBOR, checking COSE keys, and
 * validating ES256/RS256/EdDSA signatures against the exact bytes the
 * browser signed — reimplementing that from scratch isn't a reasonable
 * ask, and a subtly wrong hand-rolled verifier is a security bug, not a
 * style violation.
 *
 * Constructed once at boot with the deployment's RP identity (same
 * "configure once, use everywhere" shape as `GoogleCalendarEventsSource`
 * being constructed with a `calendarId`) — individual calls never see
 * `rpID`/`origin` again.
 */
export class SimpleWebAuthnProvider implements WebAuthnProvider {
  #rpName: string;
  #rpID: string;
  #origin: string;

  constructor(params: { rpName: string; rpID: string; origin: string }) {
    this.#rpName = params.rpName;
    this.#rpID = params.rpID;
    this.#origin = params.origin;
  }

  async generateRegistrationOptions(params: {
    userId: string;
    username: string;
    displayName: string;
    excludeCredentials: StoredPasskey[];
  }): Promise<unknown> {
    return generateRegistrationOptions({
      rpName: this.#rpName,
      rpID: this.#rpID,
      userID: new TextEncoder().encode(params.userId),
      userName: params.username,
      userDisplayName: params.displayName,
      attestationType: "none",
      excludeCredentials: params.excludeCredentials.map((c) => ({ id: c.id, transports: c.transports as never })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
  }

  /**
   * `@simplewebauthn/server` throws on malformed input (a missing
   * `clientDataJSON`, an unparseable attestation object, …) rather than
   * resolving `{ verified: false }` for it — verified live against a
   * garbage response. This interface's contract is "never rejects, only
   * resolves `verified: false`" (see `WebAuthnProvider`'s doc comment),
   * so every path through the library's own exceptions is caught here
   * rather than left to surface as an uncaught 500 at the HTTP layer.
   * `AuthService` only ever sees a clean `AuthError` either way.
   */
  async verifyRegistration(params: {
    response: unknown;
    expectedChallenge: string;
  }): Promise<{ verified: false } | { verified: true; credential: StoredPasskey }> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: params.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
        expectedChallenge: params.expectedChallenge,
        expectedOrigin: this.#origin,
        expectedRPID: this.#rpID,
      });
    } catch {
      return { verified: false };
    }
    if (!result.verified || !result.registrationInfo) return { verified: false };
    const { credential } = result.registrationInfo;
    return {
      verified: true,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        ...(credential.transports ? { transports: credential.transports } : {}),
      },
    };
  }

  async generateAuthenticationOptions(params: { allowCredentials: StoredPasskey[] }): Promise<unknown> {
    return generateAuthenticationOptions({
      rpID: this.#rpID,
      allowCredentials: params.allowCredentials.map((c) => ({ id: c.id, transports: c.transports as never })),
      userVerification: "preferred",
    });
  }

  /** Same "never rejects" contract as `verifyRegistration` above, for the same reason. */
  async verifyAuthentication(params: {
    response: unknown;
    expectedChallenge: string;
    credential: StoredPasskey;
  }): Promise<{ verified: false } | { verified: true; newCounter: number }> {
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: params.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
        expectedChallenge: params.expectedChallenge,
        expectedOrigin: this.#origin,
        expectedRPID: this.#rpID,
        credential: {
          id: params.credential.id,
          publicKey: new Uint8Array(Buffer.from(params.credential.publicKey, "base64url")),
          counter: params.credential.counter,
          ...(params.credential.transports ? { transports: params.credential.transports as never } : {}),
        },
      });
    } catch {
      return { verified: false };
    }
    if (!result.verified) return { verified: false };
    return { verified: true, newCounter: result.authenticationInfo.newCounter };
  }
}
