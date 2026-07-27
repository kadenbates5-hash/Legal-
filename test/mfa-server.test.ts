import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { LoginThrottle } from "../src/core/login-throttle.js";
import { totpCode } from "../src/core/totp.js";

let server: Server;
let baseUrl: string;
let auth: AuthService;
let auditLog: AuditLog;
let throttle: LoginThrottle;

async function login(username: string, password = "correct-horse", mfaCode?: string) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, ...(mfaCode ? { mfaCode } : {}) }),
  });
  return { res, body: (await res.json()) as Record<string, unknown>, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const post = (cookie: string, path: string, body: unknown = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  auditLog = new AuditLog();
  auth = new AuthService();
  auth.createUser({ username: "dana", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "sam", password: "correct-horse", role: "paralegal", actorId: "p1" });
  throttle = new LoginThrottle();
  const accounts = new AccountsService(auth, new AccessControl(auditLog), throttle, auditLog);
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    accounts,
    auditLog,
    loginThrottle: throttle,
    firmName: "Ruiz & Partners",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("MFA over HTTP", () => {
  it("requires a session for every /api/mfa route", async () => {
    for (const path of ["/api/mfa", "/api/mfa/begin", "/api/mfa/confirm", "/api/mfa/disable"]) {
      const res = await fetch(`${baseUrl}${path}`, { method: path === "/api/mfa" ? "GET" : "POST" });
      expect(res.status).toBe(401);
    }
  });

  it("enrolls end to end, then demands a code at the next login", async () => {
    const cookie = (await login("dana")).cookie!;

    const begun = (await (await post(cookie, "/api/mfa/begin")).json()) as { secret: string; uri: string };
    expect(begun.uri).toContain("otpauth://totp/Ruiz%20%26%20Partners:dana");

    // Still password-only: nothing is enforced until a code is proven.
    expect((await login("dana")).res.status).toBe(200);

    const confirmed = await post(cookie, "/api/mfa/confirm", { code: totpCode(begun.secret, Date.now() - 30_000) });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);

    // Now the password alone gets a challenge, not a session.
    const challenged = await login("dana");
    expect(challenged.res.status).toBe(401);
    expect(challenged.body["mfaRequired"]).toBe(true);
    expect(challenged.cookie).toBeUndefined();

    const withCode = await login("dana", "correct-horse", totpCode(begun.secret));
    expect(withCode.res.status).toBe(200);
    expect(withCode.cookie).toBeTruthy();
  });

  it("does not count an MFA challenge as a failed login attempt", async () => {
    const cookie = (await login("dana")).cookie!;
    const { secret } = (await (await post(cookie, "/api/mfa/begin")).json()) as { secret: string };
    await post(cookie, "/api/mfa/confirm", { code: totpCode(secret, Date.now() - 30_000) });

    // Six ordinary two-step sign-ins would otherwise trip a five-failure
    // lockout and shut an attorney out of their own matters.
    for (let i = 0; i < 6; i += 1) {
      expect((await login("dana")).body["mfaRequired"]).toBe(true);
    }
    const final = await login("dana", "correct-horse", totpCode(secret));
    expect(final.res.status).toBe(200);
  });

  it("counts a wrong code as a failed attempt — that one is guessing", async () => {
    const cookie = (await login("dana")).cookie!;
    const { secret } = (await (await post(cookie, "/api/mfa/begin")).json()) as { secret: string };
    await post(cookie, "/api/mfa/confirm", { code: totpCode(secret, Date.now() - 30_000) });

    for (let i = 0; i < 5; i += 1) await login("dana", "correct-horse", "000000");
    const locked = await login("dana", "correct-horse", totpCode(secret));
    expect(locked.res.status).toBe(429);
  });

  it("refuses to disable or reissue codes without the password, even holding the session", async () => {
    const cookie = (await login("dana")).cookie!;
    const { secret } = (await (await post(cookie, "/api/mfa/begin")).json()) as { secret: string };
    await post(cookie, "/api/mfa/confirm", { code: totpCode(secret, Date.now() - 30_000) });

    expect((await post(cookie, "/api/mfa/disable", { password: "nope" })).status).toBe(403);
    expect((await post(cookie, "/api/mfa/recovery-codes", { password: "nope" })).status).toBe(403);
    expect((await (await fetch(`${baseUrl}/api/mfa`, { headers: { Cookie: cookie } })).json())).toMatchObject({
      enabled: true,
    });

    const disabled = await post(cookie, "/api/mfa/disable", { password: "correct-horse" });
    expect(disabled.status).toBe(200);
    // Every session is revoked by the change, this one included.
    expect((await fetch(`${baseUrl}/api/mfa`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await login("dana")).res.status).toBe(200);
  });

  it("lets an attorney reset someone else's factor, and nobody else", async () => {
    const samCookie = (await login("sam")).cookie!;
    const { secret } = (await (await post(samCookie, "/api/mfa/begin")).json()) as { secret: string };
    await post(samCookie, "/api/mfa/confirm", { code: totpCode(secret, Date.now() - 30_000) });
    const samId = auth.listUsers().find((u) => u.username === "sam")!.id;

    // Sam holds a paralegal session — this route is not theirs.
    expect((await post(samCookie, `/api/accounts/${samId}/reset-mfa`)).status).toBe(403);

    const danaCookie = (await login("dana")).cookie!;
    const reset = await post(danaCookie, `/api/accounts/${samId}/reset-mfa`);
    expect(reset.status).toBe(200);
    expect((await reset.json())["mfaEnabled"]).toBe(false);
    expect((await login("sam")).res.status).toBe(200);

    expect(auditLog.read("attorney").some((e) => e.action === "account_mfa_reset")).toBe(true);
  });
});
