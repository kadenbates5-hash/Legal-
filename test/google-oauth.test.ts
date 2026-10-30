import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleAuthUrl, exchangeCodeForTokens, fetchGoogleAccountEmail, refreshAccessToken } from "../src/integrations/google-oauth.js";

describe("buildGoogleAuthUrl", () => {
  it("includes the client id, redirect uri, scope, and state", () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: "client1", redirectUri: "https://docket.example.com/api/calendar-connection/callback", state: "state1" }));
    expect(url.searchParams.get("client_id")).toBe("client1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://docket.example.com/api/calendar-connection/callback");
    expect(url.searchParams.get("state")).toBe("state1");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("asks for offline access and forces the consent screen, so a refresh token is issued every time", () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: "client1", redirectUri: "https://x.example.com/cb", state: "s" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("exchangeCodeForTokens / refreshAccessToken", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts the authorization_code grant and parses the response", async () => {
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ access_token: "access1", refresh_token: "refresh1", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const tokens = await exchangeCodeForTokens({ clientId: "client1", clientSecret: "secret1", redirectUri: "https://x.example.com/cb", code: "code1" });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code1");
    expect(tokens).toEqual({ accessToken: "access1", refreshToken: "refresh1", expiresInSeconds: 3600 });
  });

  it("posts the refresh_token grant and never expects a new refresh token back", async () => {
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ access_token: "access2", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const tokens = await refreshAccessToken({ clientId: "client1", clientSecret: "secret1", refreshToken: "refresh1" });

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh1");
    expect(tokens.accessToken).toBe("access2");
    expect(tokens.refreshToken).toBeUndefined();
  });

  it("throws on a non-ok response, naming the action", async () => {
    global.fetch = vi.fn(async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCodeForTokens({ clientId: "c", clientSecret: "s", redirectUri: "r", code: "bad" })).rejects.toThrow(/code exchange.*400/s);
  });

  it("throws if the response has no access_token", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r" })).rejects.toThrow(/did not include an access_token/);
  });
});

describe("fetchGoogleAccountEmail", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the email on success", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ email: "alice@example.com" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchGoogleAccountEmail("token1")).toBe("alice@example.com");
  });

  it("returns undefined on failure rather than throwing — best-effort, never blocks the connection", async () => {
    global.fetch = vi.fn(async () => new Response("error", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchGoogleAccountEmail("bad-token")).toBeUndefined();
  });

  it("returns undefined if fetch itself throws", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    expect(await fetchGoogleAccountEmail("token1")).toBeUndefined();
  });
});
