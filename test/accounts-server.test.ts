import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";

let server: Server;
let baseUrl: string;
let auth: AuthService;

async function loginCookie(username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return setCookie.split(";")[0]!;
}

function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: cookie } };
}

beforeEach(async () => {
  auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  const accounts = new AccountsService(auth, new AccessControl(new AuditLog()));
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { accounts });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("accounts HTTP API", () => {
  it("404s when account management isn't configured on the server", async () => {
    const noAccountsAuth = new AuthService();
    noAccountsAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const noAccountsServer = createReviewServer(new ReviewGateService(new WorkProductStore()), noAccountsAuth);
    await new Promise<void>((resolve) => noAccountsServer.listen(0, resolve));
    const { port } = noAccountsServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/accounts`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noAccountsServer.close(() => resolve()));
  });

  it("rejects listing accounts with no session", async () => {
    const res = await fetch(`${baseUrl}/api/accounts`);
    expect(res.status).toBe(401);
  });

  it("denies a paralegal actor with 403", async () => {
    const cookie = await loginCookie("paralegal1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/accounts`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("lists accounts for an attorney, without password hashes", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/accounts`, withCookie(cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.find((u: { username: string }) => u.username === "attorney1")).not.toHaveProperty("passwordHash");
  });

  it("creates a new account", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/accounts`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ username: "reception1", password: "correct-horse", role: "receptionist" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("receptionist");
    expect(body.disabled).toBe(false);
  });

  it("returns 400 for a duplicate username", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/accounts`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ username: "attorney1", password: "correct-horse", role: "attorney" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a too-short password", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/accounts`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ username: "new1", password: "short", role: "attorney" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("disables then re-enables an account", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const created = await (
      await fetch(
        `${baseUrl}/api/accounts`,
        withCookie(cookie, {
          method: "POST",
          body: JSON.stringify({ username: "reception1", password: "correct-horse", role: "receptionist" }),
        }),
      )
    ).json();

    const disableRes = await fetch(`${baseUrl}/api/accounts/${created.id}/disable`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).disabled).toBe(true);

    // The disabled account can no longer log in.
    const failedLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    expect(failedLogin.status).toBe(401);

    const enableRes = await fetch(`${baseUrl}/api/accounts/${created.id}/enable`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(enableRes.status).toBe(200);
    expect((await enableRes.json()).disabled).toBe(false);

    const successLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    expect(successLogin.status).toBe(200);
  });

  it("returns 409 when disabling would leave zero enabled attorneys", async () => {
    const cookie = await loginCookie("attorney1", "correct-horse");
    const meRes = await fetch(`${baseUrl}/api/me`, withCookie(cookie));
    const me = await meRes.json();
    const list = await (await fetch(`${baseUrl}/api/accounts`, withCookie(cookie))).json();
    const self = list.find((u: { username: string }) => u.username === "attorney1");

    const res = await fetch(`${baseUrl}/api/accounts/${self.id}/disable`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(409);
    expect(me.role).toBe("attorney");
  });

  it("immediately revokes a disabled user's own session, even mid-conversation", async () => {
    const attorneyCookie = await loginCookie("attorney1", "correct-horse");
    await fetch(
      `${baseUrl}/api/accounts`,
      withCookie(attorneyCookie, {
        method: "POST",
        body: JSON.stringify({ username: "reception1", password: "correct-horse", role: "receptionist" }),
      }),
    );
    const receptionistCookie = await loginCookie("reception1", "correct-horse");
    const beforeDisable = await fetch(`${baseUrl}/api/me`, withCookie(receptionistCookie));
    expect(beforeDisable.status).toBe(200);

    const list = await (await fetch(`${baseUrl}/api/accounts`, withCookie(attorneyCookie))).json();
    const receptionistAccount = list.find((u: { username: string }) => u.username === "reception1");
    await fetch(`${baseUrl}/api/accounts/${receptionistAccount.id}/disable`, withCookie(attorneyCookie, { method: "POST", body: "{}" }));

    const afterDisable = await fetch(`${baseUrl}/api/me`, withCookie(receptionistCookie));
    expect(afterDisable.status).toBe(401);
  });
});
