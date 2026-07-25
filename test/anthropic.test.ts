import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicClient, DEFAULT_MODEL } from "../src/integrations/anthropic.js";

describe("AnthropicClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts to /v1/messages with the required headers and default model", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "msg_1", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = new AnthropicClient({ apiKey: "sk-test" });
    const response = await client.createMessage({ system: "sys", messages: [{ role: "user", content: "hello" }] });

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders?.["x-api-key"]).toBe("sk-test");
    expect(capturedHeaders?.["anthropic-version"]).toBe("2023-06-01");
    expect(capturedBody?.["model"]).toBe(DEFAULT_MODEL);
    expect(capturedBody?.["system"]).toBe("sys");
    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("uses a configured model override", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "msg_1", role: "assistant", content: [], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new AnthropicClient({ apiKey: "sk-test", model: "claude-opus-5" });
    await client.createMessage({ system: "sys", messages: [] });
    expect(capturedBody?.["model"]).toBe("claude-opus-5");
  });

  it("includes tools only when provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "msg_1", role: "assistant", content: [], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new AnthropicClient({ apiKey: "sk-test" });
    await client.createMessage({ system: "sys", messages: [] });
    expect(capturedBody?.["tools"]).toBeUndefined();

    await client.createMessage({ system: "sys", messages: [], tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] });
    expect(capturedBody?.["tools"]).toHaveLength(1);
  });

  it("throws on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = new AnthropicClient({ apiKey: "sk-test" });
    await expect(client.createMessage({ system: "sys", messages: [] })).rejects.toThrow(/400/);
  });
});
