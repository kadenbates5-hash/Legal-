import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let store: WorkProductStore;
let auth: AuthService;

/** Logs in over HTTP and returns the `Cookie` header value for subsequent requests. */
async function loginCookie(url: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/api/login`, {
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
  store = new WorkProductStore();
  const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft text" }, new AuditLog());
  wp.submitForReview({ id: "p1", role: "paralegal" });
  store.register(wp);

  auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  const service = new ReviewGateService(store);
  server = createReviewServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("auth HTTP API", () => {
  it("rejects API requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/work-products?status=pending_review`);
    expect(res.status).toBe(401);
  });

  it("rejects a login with a wrong password", async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("logs in, reuses the session cookie, then logs out and loses access", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");

    const meRes = await fetch(`${baseUrl}/api/me`, withCookie(cookie));
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me).toEqual({ id: "a1", role: "attorney", username: "attorney1" });

    const okRes = await fetch(`${baseUrl}/api/work-products?status=pending_review`, withCookie(cookie));
    expect(okRes.status).toBe(200);

    const logoutRes = await fetch(`${baseUrl}/api/logout`, withCookie(cookie, { method: "POST" }));
    expect(logoutRes.status).toBe(200);

    const afterLogoutRes = await fetch(`${baseUrl}/api/work-products?status=pending_review`, withCookie(cookie));
    expect(afterLogoutRes.status).toBe(401);
  });

  it("redirects an unauthenticated request for the dashboard to /login.html", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login.html");
  });

  it("serves the dashboard once logged in", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/`, withCookie(cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Docket");
  });

  it("serves the login page without authentication", async () => {
    const res = await fetch(`${baseUrl}/login.html`);
    expect(res.status).toBe(200);
  });
});

describe("session cookie Secure flag (trust-proxy model)", () => {
  it("never marks the cookie Secure when trustProxy is off, even if the request claims to be https", async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("marks the cookie Secure when trustProxy is on and X-Forwarded-Proto says https", async () => {
    const proxiedAuth = new AuthService();
    proxiedAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const proxiedServer = createReviewServer(
      new ReviewGateService(new WorkProductStore()),
      proxiedAuth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // trustProxy
    );
    await new Promise<void>((resolve) => proxiedServer.listen(0, resolve));
    const { port } = proxiedServer.address() as AddressInfo;
    const proxiedUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${proxiedUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);

    await new Promise<void>((resolve) => proxiedServer.close(() => resolve()));
  });

  it("does not mark the cookie Secure when trustProxy is on but the proxy reports plain http", async () => {
    const proxiedAuth = new AuthService();
    proxiedAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const proxiedServer = createReviewServer(
      new ReviewGateService(new WorkProductStore()),
      proxiedAuth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // trustProxy
    );
    await new Promise<void>((resolve) => proxiedServer.listen(0, resolve));
    const { port } = proxiedServer.address() as AddressInfo;
    const proxiedUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${proxiedUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "http" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);

    await new Promise<void>((resolve) => proxiedServer.close(() => resolve()));
  });
});

describe("review-gate HTTP API", () => {
  it("lists pending-review work product for an attorney", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/work-products?status=pending_review`, withCookie(cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("wp1");
  });

  it("denies a paralegal actor with 403, not a silent empty list", async () => {
    const cookie = await loginCookie(baseUrl, "paralegal1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/work-products`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("gets work-product detail including content", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/work-products/wp1`, withCookie(cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("draft text");
  });

  it("returns 404 for an unknown id", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/work-products/nope`, withCookie(cookie));
    expect(res.status).toBe(404);
  });

  it("approves then releases a work product end to end", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const approveRes = await fetch(`${baseUrl}/api/work-products/wp1/approve`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).status).toBe("approved");

    const releaseRes = await fetch(`${baseUrl}/api/work-products/wp1/release`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(releaseRes.status).toBe(200);
    expect((await releaseRes.json()).status).toBe("released");
  });

  it("returns 409 for an invalid state transition (release before approval)", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/work-products/wp1/release`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(409);
  });

  it("rejects a work product with a reason", async () => {
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/work-products/wp1/reject`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ reason: "not viable" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rejected");
  });

  it("clears a flag by name", async () => {
    store.get("wp1")!.addFlag("padilla_advisory_required");
    const cookie = await loginCookie(baseUrl, "attorney1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/work-products/wp1/clear-flag`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ flag: "padilla_advisory_required" }) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).not.toContain("padilla_advisory_required");
  });
});

describe("review-gate HTTP API persistence hook", () => {
  it("fires onMutated on login/logout and on a successful mutation, but not on a plain read", async () => {
    const auditLog = new AuditLog();
    const hookStore = new WorkProductStore();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "x" }, auditLog);
    wp.submitForReview({ id: "p1", role: "paralegal" });
    hookStore.register(wp);

    const hookAuth = new AuthService();
    hookAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });

    let mutationCount = 0;
    const hookServer = createReviewServer(new ReviewGateService(hookStore), hookAuth, () => {
      mutationCount += 1;
    });
    await new Promise<void>((resolve) => hookServer.listen(0, resolve));
    const { port } = hookServer.address() as AddressInfo;
    const hookBaseUrl = `http://127.0.0.1:${port}`;

    const cookie = await loginCookie(hookBaseUrl, "attorney1", "correct-horse");
    expect(mutationCount).toBe(1); // login itself persists the new session

    await fetch(`${hookBaseUrl}/api/work-products/wp1`, withCookie(cookie));
    expect(mutationCount).toBe(1);

    await fetch(`${hookBaseUrl}/api/work-products/wp1/approve`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(mutationCount).toBe(2);

    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });
});

describe("deadline HTTP API", () => {
  let deadlineServer: Server;
  let deadlineBaseUrl: string;
  let deadlineAuth: AuthService;

  beforeEach(async () => {
    deadlineAuth = new AuthService();
    deadlineAuth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    deadlineAuth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    deadlineAuth.setSystemApiKey("the-calendar-integration-key-1234");

    const service = new ReviewGateService(new WorkProductStore(), new DeadlineTracker());
    deadlineServer = createReviewServer(service, deadlineAuth);
    await new Promise<void>((resolve) => deadlineServer.listen(0, resolve));
    const { port } = deadlineServer.address() as AddressInfo;
    deadlineBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => deadlineServer.close(() => resolve()));
  });

  it("reports unconfirmed for a deadline with no calculations yet", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "attorney1", "correct-horse");
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines?matterId=m1&type=speedy_trial`, withCookie(cookie));
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("unconfirmed");
  });

  it("confirms a deadline once two independent sources agree: the calendar integration's key plus an attorney", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "attorney1", "correct-horse");

    await fetch(`${deadlineBaseUrl}/api/deadlines/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": "the-calendar-integration-key-1234" },
      body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "calendar_system" }),
    });
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines?matterId=m1&type=speedy_trial`, withCookie(cookie));
    // Only one (non-agent) source so far — still unconfirmed, since confirmation needs two distinct sources.
    expect((await res.json()).state).toBe("unconfirmed");

    await fetch(
      `${deadlineBaseUrl}/api/deadlines/confirm`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" }),
      }),
    );
    const confirmedRes = await fetch(`${deadlineBaseUrl}/api/deadlines?matterId=m1&type=speedy_trial`, withCookie(cookie));
    expect((await confirmedRes.json()).state).toBe("confirmed");
  });

  it("rejects a 'calendar_system' confirmation from a logged-in attorney without the system API key", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "attorney1", "correct-horse");
    const res = await fetch(
      `${deadlineBaseUrl}/api/deadlines/confirm`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "calendar_system" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a 'human' confirmation presented via the system API key (not an attorney)", async () => {
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": "the-calendar-integration-key-1234" },
      body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid system API key with 401", async () => {
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": "totally-wrong-key" },
      body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "calendar_system" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a confirm request with an invalid source", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "attorney1", "correct-horse");
    const res = await fetch(
      `${deadlineBaseUrl}/api/deadlines/confirm`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "agent" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("denies deadline endpoints to a non-attorney actor", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "paralegal1", "correct-horse");
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines?matterId=m1&type=speedy_trial`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("lists conflicts across the system", async () => {
    const cookie = await loginCookie(deadlineBaseUrl, "attorney1", "correct-horse");
    await fetch(
      `${deadlineBaseUrl}/api/deadlines/confirm`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-01", source: "human" }),
      }),
    );
    await fetch(`${deadlineBaseUrl}/api/deadlines/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-system-api-key": "the-calendar-integration-key-1234" },
      body: JSON.stringify({ matterId: "m1", type: "speedy_trial", date: "2026-09-05", source: "calendar_system" }),
    });
    const res = await fetch(`${deadlineBaseUrl}/api/deadlines/conflicts`, withCookie(cookie));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].matterId).toBe("m1");
  });
});
