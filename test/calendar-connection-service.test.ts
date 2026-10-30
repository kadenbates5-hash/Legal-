import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarConnectionService } from "../src/review-ui/calendar-connection-service.js";
import { CalendarConnectionStore } from "../src/core/calendar-connections.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const system: Actor = { id: "sys", role: "system" };

let store: CalendarConnectionStore;
let auditLog: AuditLog;
let auth: AuthService;
let service: CalendarConnectionService;

function fakeTokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  store = new CalendarConnectionStore();
  auditLog = new AuditLog();
  auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  service = new CalendarConnectionService({
    store,
    clientId: "client1",
    clientSecret: "secret1",
    redirectUri: "https://docket.example.com/api/calendar-connection/callback",
    auditLog,
    auth,
  });
});

describe("CalendarConnectionService.status", () => {
  it("reports not connected by default", () => {
    expect(service.status(attorney)).toEqual({ connected: false });
  });

  it("reports connected with the email once a connection exists", () => {
    store.set({ actorId: "a1", refreshToken: "r1", connectedEmail: "alice@example.com", connectedAt: "2026-01-01T00:00:00Z" });
    expect(service.status(attorney)).toEqual({ connected: true, connectedEmail: "alice@example.com" });
  });
});

describe("CalendarConnectionService.beginConnect / completeConnect", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("issues an auth URL bound to the actor, and completeConnect redeems it for that actor", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return fakeTokenResponse({ access_token: "access1", refresh_token: "refresh1", expires_in: 3600 });
      }
      return fakeTokenResponse({ email: "alice@example.com" });
    }) as unknown as typeof fetch;

    const { authUrl } = service.beginConnect(attorney);
    const state = new URL(authUrl).searchParams.get("state")!;

    const result = await service.completeConnect("code1", state);
    expect(result).toEqual({ actorId: "a1" });
    expect(service.status(attorney)).toEqual({ connected: true, connectedEmail: "alice@example.com" });
  });

  it("rejects an unknown or already-used state", async () => {
    await expect(service.completeConnect("code1", "never-issued")).rejects.toThrow(/invalid or has expired/);
  });

  it("a state can only be redeemed once", async () => {
    global.fetch = vi.fn(async () => fakeTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 })) as unknown as typeof fetch;
    const { authUrl } = service.beginConnect(attorney);
    const state = new URL(authUrl).searchParams.get("state")!;
    await service.completeConnect("code1", state);
    await expect(service.completeConnect("code1", state)).rejects.toThrow(/invalid or has expired/);
  });

  it("rejects when Google doesn't grant a refresh token", async () => {
    global.fetch = vi.fn(async () => fakeTokenResponse({ access_token: "a", expires_in: 3600 })) as unknown as typeof fetch;
    const { authUrl } = service.beginConnect(attorney);
    const state = new URL(authUrl).searchParams.get("state")!;
    await expect(service.completeConnect("code1", state)).rejects.toThrow(/didn't grant a refresh token/);
    expect(service.status(attorney)).toEqual({ connected: false });
  });

  it("audits the connection with the real role resolved from AuthService", async () => {
    global.fetch = vi.fn(async () => fakeTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 })) as unknown as typeof fetch;
    const { authUrl } = service.beginConnect(attorney);
    const state = new URL(authUrl).searchParams.get("state")!;
    await service.completeConnect("code1", state);

    const entry = auditLog.read("attorney").find((e) => e.action === "calendar_connected");
    expect(entry?.actor).toEqual({ id: "a1", role: "attorney" });
  });
});

describe("CalendarConnectionService.disconnect", () => {
  it("removes the connection and audits it", () => {
    store.set({ actorId: "a1", refreshToken: "r1", connectedEmail: "alice@example.com", connectedAt: "2026-01-01T00:00:00Z" });
    service.disconnect(attorney);
    expect(service.status(attorney)).toEqual({ connected: false });
    expect(auditLog.read("attorney").find((e) => e.action === "calendar_disconnected")).toBeDefined();
  });
});

describe("CalendarConnectionService.accessTokenFor", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is system-only", async () => {
    await expect(service.accessTokenFor(attorney, "a1")).rejects.toThrow(AccessDeniedError);
  });

  it("reports not connected for an attorney with no connection", async () => {
    expect(await service.accessTokenFor(system, "a1")).toEqual({ connected: false });
  });

  it("refreshes and returns a fresh access token for a connected attorney, never the refresh token itself", async () => {
    store.set({ actorId: "a1", refreshToken: "refresh1", connectedEmail: undefined, connectedAt: "2026-01-01T00:00:00Z" });
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return fakeTokenResponse({ access_token: "fresh-access-token", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const result = await service.accessTokenFor(system, "a1");
    expect(result).toEqual({ connected: true, accessToken: "fresh-access-token" });
    expect(new URLSearchParams(capturedBody).get("refresh_token")).toBe("refresh1");
  });
});
