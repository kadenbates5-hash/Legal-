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
import { totpCode } from "../src/core/totp.js";

let server: Server;
let baseUrl: string;
let auth: AuthService;

async function login(username: string, password = "correct-horse", mfaCode?: string) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, ...(mfaCode ? { mfaCode } : {}) }),
  });
  return { res, body: (await res.json()) as Record<string, unknown>, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

const get = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
const post = (cookie: string, path: string, body: unknown = {}) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

function startServer(mfaRequiredRoles?: ReadonlySet<"attorney" | "paralegal" | "receptionist" | "staff" | "client">) {
  auth = new AuthService();
  auth.createUser({ username: "dana", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
  const accounts = new AccountsService(auth, new AccessControl(new AuditLog()), undefined, new AuditLog());
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    accounts,
    ...(mfaRequiredRoles ? { mfaRequiredRoles } : {}),
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("firm-wide MFA requirement", () => {
  it("with no policy configured, an unenrolled account reaches everything as before", async () => {
    startServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = (await login("dana")).cookie!;
    expect((await get(cookie, "/api/accounts")).status).toBe(200);
  });

  it("blocks an unenrolled required-role account from everything except the setup allowlist, but still lets it log in", async () => {
    startServer(new Set(["attorney"]));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const loggedIn = await login("dana");
    expect(loggedIn.res.status).toBe(200);
    const cookie = loggedIn.cookie!;

    const blocked = await get(cookie, "/api/accounts");
    expect(blocked.status).toBe(403);
    expect((await blocked.json())["mfaSetupRequired"]).toBe(true);

    // The allowlist itself must stay reachable — otherwise there'd be no way in.
    expect((await get(cookie, "/api/me")).status).toBe(200);
    expect((await post(cookie, "/api/mfa/begin", { password: "correct-horse" })).status).toBe(200);
    expect((await post(cookie, "/api/change-password", { currentPassword: "correct-horse", newPassword: "new-password-1" })).status).toBe(200);
  });

  it("/api/me reports mfaSetupRequired so the dashboard can show a banner", async () => {
    startServer(new Set(["attorney"]));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = (await login("dana")).cookie!;
    const me = (await (await get(cookie, "/api/me")).json()) as Record<string, unknown>;
    expect(me["mfaSetupRequired"]).toBe(true);
  });

  it("does not apply to a role not named in the policy", async () => {
    startServer(new Set(["attorney"]));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = (await login("reception1")).cookie!;
    const me = (await (await get(cookie, "/api/me")).json()) as Record<string, unknown>;
    expect(me["mfaSetupRequired"]).toBe(false);
  });

  it("unblocks the moment enrollment is confirmed, with no new login required", async () => {
    startServer(new Set(["attorney"]));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = (await login("dana")).cookie!;

    const { secret } = (await (await post(cookie, "/api/mfa/begin", { password: "correct-horse" })).json()) as { secret: string };
    expect((await get(cookie, "/api/accounts")).status).toBe(403);

    await post(cookie, "/api/mfa/confirm", { code: totpCode(secret, Date.now() - 30_000) });
    expect((await get(cookie, "/api/accounts")).status).toBe(200);
  });
});
