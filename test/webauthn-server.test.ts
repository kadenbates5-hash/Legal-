import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { LoginThrottle } from "../src/core/login-throttle.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import type { WebAuthnProvider } from "../src/integrations/webauthn-provider.js";

let server: Server;
let baseUrl: string;
let auth: AuthService;
let auditLog: AuditLog;
let throttle: LoginThrottle;

function fakeProvider(): WebAuthnProvider {
  let n = 0;
  return {
    async generateRegistrationOptions() {
      n += 1;
      return { challenge: `reg-${n}` };
    },
    async verifyRegistration({ expectedChallenge }) {
      return { verified: true, credential: { id: `cred-${expectedChallenge}`, publicKey: "pk", counter: 0 } };
    },
    async generateAuthenticationOptions() {
      n += 1;
      return { challenge: `auth-${n}` };
    },
    async verifyAuthentication() {
      return { verified: true, newCounter: 1 };
    },
  };
}

async function login(username: string, password = "correct-horse", mfaCode?: string) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, ...(mfaCode ? { mfaCode } : {}) }),
  });
  return { res, body: (await res.json()) as Record<string, unknown>, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const post = (cookie: string, path: string, body: unknown = {}, method = "POST") =>
  fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

beforeEach(async () => {
  auditLog = new AuditLog();
  auth = new AuthService();
  auth.setWebAuthnProvider(fakeProvider());
  auth.createUser({ username: "dana", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "bob", password: "correct-horse", role: "paralegal", actorId: "p1" });
  throttle = new LoginThrottle();
  const accounts = new AccountsService(auth, new AccessControl(auditLog), throttle, auditLog);
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    auditLog,
    loginThrottle: throttle,
    accounts,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("passkey management over HTTP (/api/webauthn)", () => {
  it("requires a session for every route", async () => {
    expect((await fetch(`${baseUrl}/api/webauthn`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/webauthn/register/begin`, { method: "POST" })).status).toBe(401);
  });

  it("registers a passkey end to end and lists it without the public key", async () => {
    const cookie = (await login("dana")).cookie!;
    const begin = await post(cookie, "/api/webauthn/register/begin", { password: "correct-horse" });
    expect(begin.status).toBe(200);
    const options = (await begin.json()) as { challenge: string };
    expect(options.challenge).toMatch(/^reg-/);

    const complete = await post(cookie, "/api/webauthn/register/complete", { response: {}, nickname: "YubiKey" });
    expect(complete.status).toBe(200);
    const record = (await complete.json()) as { id: string; nickname: string };
    expect(record.nickname).toBe("YubiKey");
    expect(record).not.toHaveProperty("publicKey");

    const list = (await (await fetch(`${baseUrl}/api/webauthn`, { headers: { Cookie: cookie } })).json()) as unknown[];
    expect(list).toEqual([{ id: record.id, nickname: "YubiKey", createdAt: expect.any(String) }]);

    expect(auditLog.read("attorney").some((e) => e.action === "passkey_added")).toBe(true);
  });

  it("refuses to begin registration with the wrong password", async () => {
    const cookie = (await login("dana")).cookie!;
    const res = await post(cookie, "/api/webauthn/register/begin", { password: "wrong" });
    expect(res.status).toBe(403);
  });

  it("removes a passkey, requiring the password", async () => {
    const cookie = (await login("dana")).cookie!;
    await post(cookie, "/api/webauthn/register/begin", { password: "correct-horse" });
    const record = (await (await post(cookie, "/api/webauthn/register/complete", { response: {}, nickname: "x" })).json()) as { id: string };

    const wrongPassword = await post(cookie, `/api/webauthn/${record.id}`, { password: "nope" }, "DELETE");
    expect(wrongPassword.status).toBe(403);

    const removed = await post(cookie, `/api/webauthn/${record.id}`, { password: "correct-horse" }, "DELETE");
    expect(removed.status).toBe(200);
    expect(auditLog.read("attorney").some((e) => e.action === "passkey_removed")).toBe(true);

    // This was the account's only factor, so removing it revoked every
    // session including the one that just made this call — fresh login
    // needed to check the list is now empty.
    const freshCookie = (await login("dana")).cookie!;
    expect((await (await fetch(`${baseUrl}/api/webauthn`, { headers: { Cookie: freshCookie } })).json())).toEqual([]);
  });
});

describe("passkey login over HTTP (/api/login/passkey/*)", () => {
  async function registerPasskey(cookie: string): Promise<string> {
    await post(cookie, "/api/webauthn/register/begin", { password: "correct-horse" });
    const record = (await (await post(cookie, "/api/webauthn/register/complete", { response: {}, nickname: "x" })).json()) as { id: string };
    return record.id;
  }

  it("a passkey-only account is challenged at plain login, with hasPasskey true", async () => {
    const cookie = (await login("dana")).cookie!;
    await registerPasskey(cookie);

    const attempt = await login("dana");
    expect(attempt.res.status).toBe(401);
    expect(attempt.body["mfaRequired"]).toBe(true);
    expect(attempt.body["hasPasskey"]).toBe(true);
  });

  it("completes a passkey sign-in end to end", async () => {
    const cookie = (await login("dana")).cookie!;
    const credentialId = await registerPasskey(cookie);

    const begin = await fetch(`${baseUrl}/api/login/passkey/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dana", password: "correct-horse" }),
    });
    expect(begin.status).toBe(200);
    const options = (await begin.json()) as { challenge: string };
    expect(options.challenge).toMatch(/^auth-/);

    const complete = await fetch(`${baseUrl}/api/login/passkey/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dana", response: { id: credentialId }, remember: false }),
    });
    expect(complete.status).toBe(200);
    expect(complete.headers.get("set-cookie")).toBeTruthy();
    expect(auditLog.read("attorney").some((e) => e.action === "login_succeeded" && e.detail?.includes("via=passkey"))).toBe(true);
  });

  it("begin refuses the wrong password, and counts it against the login throttle", async () => {
    const cookie = (await login("dana")).cookie!;
    await registerPasskey(cookie);

    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${baseUrl}/api/login/passkey/begin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dana", password: "wrong" }),
      });
      // Same generic "invalid username or password" as a plain /api/login
      // failure — there's no existing session for this to weaken, so it's
      // a login failure (401), not a self-service "wrong current password"
      // on an authenticated caller (403, see /api/mfa/disable etc.).
      expect(res.status).toBe(401);
    }
    const locked = await fetch(`${baseUrl}/api/login/passkey/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dana", password: "correct-horse" }),
    });
    expect(locked.status).toBe(429);
  });

  it("complete rejects an unrecognized credential", async () => {
    const cookie = (await login("dana")).cookie!;
    await registerPasskey(cookie);
    await fetch(`${baseUrl}/api/login/passkey/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dana", password: "correct-horse" }),
    });
    const res = await fetch(`${baseUrl}/api/login/passkey/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dana", response: { id: "bogus" }, remember: false }),
    });
    expect(res.status).toBe(401);
  });
});

describe("attorney reset-mfa clears passkeys too, not just TOTP", () => {
  it("resets a passkey-only account's factor entirely, so they can sign in again", async () => {
    const bobCookie = (await login("bob")).cookie!;
    await post(bobCookie, "/api/webauthn/register/begin", { password: "correct-horse" });
    await post(bobCookie, "/api/webauthn/register/complete", { response: {}, nickname: "Lost phone" });

    // Locked out: plain password alone now gets a challenge, not a session.
    expect((await login("bob")).res.status).toBe(401);

    const bobId = auth.listUsers().find((u) => u.username === "bob")!.id;
    const danaCookie = (await login("dana")).cookie!;
    const reset = await post(danaCookie, `/api/accounts/${bobId}/reset-mfa`);
    expect(reset.status).toBe(200);
    const summary = (await reset.json()) as { mfaEnabled: boolean; passkeyCount: number };
    expect(summary.passkeyCount).toBe(0);

    expect((await login("bob")).res.status).toBe(200);
    expect(auditLog.read("attorney").some((e) => e.action === "account_mfa_reset" && e.detail?.includes("hadPasskeys=true"))).toBe(true);
  });

  it("surfaces passkeyCount on the account list", async () => {
    const bobCookie = (await login("bob")).cookie!;
    await post(bobCookie, "/api/webauthn/register/begin", { password: "correct-horse" });
    await post(bobCookie, "/api/webauthn/register/complete", { response: {}, nickname: "x" });

    const danaCookie = (await login("dana")).cookie!;
    const list = (await (await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: danaCookie } })).json()) as { username: string; passkeyCount: number }[];
    expect(list.find((a) => a.username === "bob")?.passkeyCount).toBe(1);
    expect(list.find((a) => a.username === "dana")?.passkeyCount).toBe(0);
  });
});
