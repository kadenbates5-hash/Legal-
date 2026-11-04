import { describe, expect, it } from "vitest";
import { SimpleWebAuthnProvider } from "../src/integrations/webauthn-provider.js";

function provider(): SimpleWebAuthnProvider {
  return new SimpleWebAuthnProvider({ rpName: "Docket Test", rpID: "localhost", origin: "http://localhost:3000" });
}

describe("SimpleWebAuthnProvider.generateRegistrationOptions", () => {
  it("returns options carrying the configured rp identity and a challenge", async () => {
    const options = (await provider().generateRegistrationOptions({
      userId: "user_1",
      username: "alice",
      displayName: "Alice Attorney",
      excludeCredentials: [],
    })) as { rp: { id: string; name: string }; user: { name: string }; challenge: string; excludeCredentials: unknown[] };

    expect(options.rp).toEqual({ id: "localhost", name: "Docket Test" });
    expect(options.user.name).toBe("alice");
    expect(typeof options.challenge).toBe("string");
    expect(options.challenge.length).toBeGreaterThan(0);
    expect(options.excludeCredentials).toEqual([]);
  });

  it("maps excludeCredentials through to the options", async () => {
    const options = (await provider().generateRegistrationOptions({
      userId: "user_1",
      username: "alice",
      displayName: "Alice",
      excludeCredentials: [{ id: "cred-1", publicKey: "x", counter: 0, transports: ["internal"] }],
    })) as { excludeCredentials: { id: string }[] };
    expect(options.excludeCredentials).toHaveLength(1);
    expect(options.excludeCredentials[0]?.id).toBe("cred-1");
  });
});

describe("SimpleWebAuthnProvider.generateAuthenticationOptions", () => {
  it("returns options scoped to the given credentials, with a challenge", async () => {
    const options = (await provider().generateAuthenticationOptions({
      allowCredentials: [{ id: "cred-1", publicKey: "x", counter: 0 }],
    })) as { rpId: string; challenge: string; allowCredentials: { id: string }[] };
    expect(options.rpId).toBe("localhost");
    expect(typeof options.challenge).toBe("string");
    expect(options.allowCredentials).toHaveLength(1);
    expect(options.allowCredentials[0]?.id).toBe("cred-1");
  });
});

describe("SimpleWebAuthnProvider verification — malformed input fails closed, never throws", () => {
  it("verifyRegistration rejects a garbage response without crashing the caller", async () => {
    const result = await provider().verifyRegistration({
      response: { id: "x", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} },
      expectedChallenge: "abc",
    });
    expect(result.verified).toBe(false);
  });

  it("verifyAuthentication rejects a garbage response without crashing the caller", async () => {
    const result = await provider().verifyAuthentication({
      response: { id: "x", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} },
      expectedChallenge: "abc",
      credential: { id: "x", publicKey: Buffer.from("not-a-real-key").toString("base64url"), counter: 0 },
    });
    expect(result.verified).toBe(false);
  });
});
