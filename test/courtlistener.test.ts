import { afterEach, describe, expect, it, vi } from "vitest";
import { CourtListenerClient, parseSearchResult } from "../src/integrations/courtlistener.js";

describe("parseSearchResult", () => {
  it("parses a well-formed result", () => {
    const result = parseSearchResult({
      caseName: "Roe v. Wade",
      citation: ["410 U.S. 113"],
      court: "Supreme Court of the United States",
      dateFiled: "1973-01-22",
      snippet: "...",
      absolute_url: "/opinion/108713/roe-v-wade/",
    });
    expect(result).toEqual({
      caseName: "Roe v. Wade",
      citations: ["410 U.S. 113"],
      court: "Supreme Court of the United States",
      dateFiled: "1973-01-22",
      snippet: "...",
      url: "https://www.courtlistener.com/opinion/108713/roe-v-wade/",
    });
  });

  it("leaves an already-absolute url untouched", () => {
    const result = parseSearchResult({ caseName: "X", absolute_url: "https://example.com/x" });
    expect(result?.url).toBe("https://example.com/x");
  });

  it("defaults citations to an empty array when absent", () => {
    const result = parseSearchResult({ caseName: "X", absolute_url: "/x" });
    expect(result?.citations).toEqual([]);
  });

  it("rejects a result missing caseName", () => {
    expect(parseSearchResult({ absolute_url: "/x" })).toBeUndefined();
  });

  it("rejects a result missing absolute_url", () => {
    expect(parseSearchResult({ caseName: "X" })).toBeUndefined();
  });
});

describe("CourtListenerClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("searches opinions (type=o) and parses results", async () => {
    let capturedUrl: URL | undefined;
    global.fetch = vi.fn(async (url: URL) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ results: [{ caseName: "Roe v. Wade", citation: ["410 U.S. 113"], absolute_url: "/opinion/1/roe/" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new CourtListenerClient();
    const results = await client.search("abortion");

    expect(capturedUrl?.searchParams.get("q")).toBe("abortion");
    expect(capturedUrl?.searchParams.get("type")).toBe("o");
    expect(results).toHaveLength(1);
    expect(results[0]?.caseName).toBe("Roe v. Wade");
  });

  it("sends a Token authorization header when an apiToken is configured", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CourtListenerClient({ apiToken: "tok123" });
    await client.search("x");
    expect(capturedHeaders?.["Authorization"]).toBe("Token tok123");
  });

  it("sends no Authorization header when unauthenticated", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    global.fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new CourtListenerClient();
    await client.search("x");
    expect(capturedHeaders?.["Authorization"]).toBeUndefined();
  });

  it("skips malformed results rather than failing the whole search", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ caseName: "Good", absolute_url: "/x" }, { caseName: "Bad, no url" }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const client = new CourtListenerClient();
    const results = await client.search("x");
    expect(results).toHaveLength(1);
    expect(results[0]?.caseName).toBe("Good");
  });

  it("throws on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const client = new CourtListenerClient();
    await expect(client.search("x")).rejects.toThrow(/500/);
  });
});
