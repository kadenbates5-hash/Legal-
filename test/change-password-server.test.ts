import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;

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
  const auth = new AuthService();
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("self-service password change", () => {
  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/change-password`, {
      method: "POST",
      body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "new-password-123" }),
    });
    expect(res.status).toBe(401);
  });

  it("is available to any role, not gated like the attorney-only surfaces", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/change-password`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "new-password-123" }) }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 (not 401) for a wrong current password, so the dashboard doesn't redirect to login", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/change-password`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "new-password-123" }) }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for a too-short new password", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/change-password`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "short" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("clears the session cookie and revokes the session on success, requiring a fresh login", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const changeRes = await fetch(
      `${baseUrl}/api/change-password`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "new-password-123" }) }),
    );
    expect(changeRes.status).toBe(200);
    expect(changeRes.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    const afterChange = await fetch(`${baseUrl}/api/me`, withCookie(cookie));
    expect(afterChange.status).toBe(401);
  });

  it("lets the user log in with the new password afterward", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    await fetch(
      `${baseUrl}/api/change-password`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ currentPassword: "correct-horse", newPassword: "new-password-123" }) }),
    );

    const oldLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "new-password-123" }),
    });
    expect(newLogin.status).toBe(200);
  });
});
