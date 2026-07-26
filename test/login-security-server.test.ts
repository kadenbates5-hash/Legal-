import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { LoginThrottle } from "../src/core/login-throttle.js";

let server: Server;
let baseUrl: string;
let auditLog: AuditLog;

const GOOD = "correct-horse";

async function login(username: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

beforeEach(async () => {
  auditLog = new AuditLog();
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: GOOD, role: "attorney", actorId: "a1" });
  const accessControl = new AccessControl(auditLog);

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    loginThrottle: new LoginThrottle({ maxFailures: 3 }),
    auditLog,
    accounts: new AccountsService(auth, accessControl, new LoginThrottle({ maxFailures: 3 })),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("login brute-force protection", () => {
  it("returns 429 with Retry-After once the threshold is passed", async () => {
    for (let i = 0; i < 3; i++) expect((await login("attorney1", "nope")).status).toBe(401);
    const blocked = await login("attorney1", "nope");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses even the correct password while locked out — otherwise throttling would be pointless", async () => {
    for (let i = 0; i < 3; i++) await login("attorney1", "nope");
    expect((await login("attorney1", GOOD)).status).toBe(429);
  });

  it("does not leak whether a username exists", async () => {
    const real = await login("attorney1", "nope");
    const fake = await login("nobody-here", "nope");
    expect(real.status).toBe(fake.status);
    expect((await real.json()).error).toBe((await fake.json()).error);
  });

  it("clears the counter after a successful login", async () => {
    for (let i = 0; i < 2; i++) await login("attorney1", "nope");
    expect((await login("attorney1", GOOD)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await login("attorney1", "nope")).status).toBe(401);
  });

  it("records login outcomes in the audit log without inventing a matter or a role", async () => {
    await login("attorney1", "nope");
    await login("attorney1", GOOD);
    const entries = auditLog.read("attorney");
    const failed = entries.find((e) => e.action === "login_failed");
    const ok = entries.find((e) => e.action === "login_succeeded");
    expect(failed).toBeDefined();
    expect(ok).toBeDefined();
    // Auth events aren't scoped to a matter, and a pre-credential attempt is
    // "anonymous" rather than the calendar integration's "system" role.
    expect(failed!.matterId).toBeUndefined();
    expect(failed!.actor.role).toBe("anonymous");
    expect(ok!.actor.role).toBe("attorney");
  });

  it("audits a blocked attempt distinctly from an ordinary failure", async () => {
    for (let i = 0; i < 4; i++) await login("attorney1", "nope");
    expect(auditLog.read("attorney").some((e) => e.action === "login_blocked")).toBe(true);
  });
});

describe("security headers", () => {
  it("sends a script-src 'self' CSP with no unsafe-inline, plus clickjacking and sniffing defenses", async () => {
    const res = await fetch(`${baseUrl}/api/me`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("lockout escape hatch", () => {
  it("is attorney-only", async () => {
    const res = await fetch(`${baseUrl}/api/accounts/anything/clear-login-lockout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1" }),
    });
    // No session at all -> 401 before the attorney gate is even reached.
    expect(res.status).toBe(401);
  });
});
