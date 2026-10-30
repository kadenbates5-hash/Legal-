import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import { AuditLog } from "../src/core/audit.js";
import { CalendarConnectionStore } from "../src/core/calendar-connections.js";
import { CalendarConnectionService } from "../src/review-ui/calendar-connection-service.js";

const SYSTEM_API_KEY = "test-system-key-1234567890";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let store: CalendarConnectionStore;

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
  auth.setSystemApiKey(SYSTEM_API_KEY);
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  store = new CalendarConnectionStore();
  const calendarConnection = new CalendarConnectionService({
    store,
    clientId: "client1",
    clientSecret: "secret1",
    redirectUri: "https://docket.example.com/api/calendar-connection/callback",
    auditLog: new AuditLog(),
    auth,
  });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { calendarConnection });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("calendar connection HTTP API", () => {
  it("404s when not configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const bareUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    const login = await fetch(`${bareUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${bareUrl}/api/calendar-connection`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it("reports not connected by default, for the logged-in attorney", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection`, withCookie(attorneyCookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it("requires a session", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection`);
    expect(res.status).toBe(401);
  });

  it("begin returns a real Google auth URL carrying a state param", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection/begin`, withCookie(attorneyCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    const { authUrl } = await res.json();
    const url = new URL(authUrl);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("disconnect removes an existing connection", async () => {
    store.set({ actorId: "a1", refreshToken: "r1", connectedEmail: "alice@example.com", connectedAt: "2026-01-01T00:00:00Z" });
    const res = await fetch(`${baseUrl}/api/calendar-connection/disconnect`, withCookie(attorneyCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(200);
    const status = await fetch(`${baseUrl}/api/calendar-connection`, withCookie(attorneyCookie));
    expect(await status.json()).toEqual({ connected: false });
  });
});

describe("GET /api/calendar-connection/callback", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("redeems a valid code+state and redirects to the app with a success flag", async () => {
    const begin = await fetch(`${baseUrl}/api/calendar-connection/begin`, withCookie(attorneyCookie, { method: "POST", body: "{}" }));
    const { authUrl } = await begin.json();
    const state = new URL(authUrl).searchParams.get("state")!;

    const realFetch = global.fetch;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("googleapis.com/oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "alice@example.com" }), { status: 200 });
      }
      return realFetch(url, init);
    }) as unknown as typeof fetch;

    const res = await fetch(`${baseUrl}/api/calendar-connection/callback?code=code1&state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?calendarConnected=1");

    const status = await fetch(`${baseUrl}/api/calendar-connection`, withCookie(attorneyCookie));
    expect(await status.json()).toEqual({ connected: true, connectedEmail: "alice@example.com" });
  });

  it("redirects with an error flag for a bogus state, without throwing a 500", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection/callback?code=code1&state=bogus`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/\?calendarError=/);
  });
});

describe("GET /api/calendar-connection/actor/:id/token", () => {
  it("is system-only", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection/actor/a1/token`, withCookie(attorneyCookie));
    expect(res.status).toBe(403);
  });

  it("reports not connected for an unconnected attorney, for the system credential", async () => {
    const res = await fetch(`${baseUrl}/api/calendar-connection/actor/a1/token`, { headers: { "x-system-api-key": SYSTEM_API_KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });
});
