import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioSmsSender } from "../src/integrations/twilio-sms.js";

describe("TwilioSmsSender", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts To/From/Body with Basic auth to the Messages endpoint", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ sid: "SM123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const sender = new TwilioSmsSender({ accountSid: "AC1", authToken: "token1", fromNumber: "+15559990000" });
    const result = await sender.send({ to: "+15551234567", text: "Reminder: your appointment is tomorrow." });

    expect(capturedUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("AC1:token1").toString("base64")}`);
    const params = new URLSearchParams(capturedBody);
    expect(params.get("To")).toBe("+15551234567");
    expect(params.get("From")).toBe("+15559990000");
    expect(params.get("Body")).toBe("Reminder: your appointment is tomorrow.");
    expect(result.messageId).toBe("SM123");
  });

  it("throws on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("invalid number", { status: 400 })) as unknown as typeof fetch;
    const sender = new TwilioSmsSender({ accountSid: "AC1", authToken: "token1", fromNumber: "+15559990000" });
    await expect(sender.send({ to: "+15551234567", text: "hi" })).rejects.toThrow(/400/);
  });

  it("reports canSend true, unlike the unconfigured default", () => {
    const sender = new TwilioSmsSender({ accountSid: "AC1", authToken: "token1", fromNumber: "+15559990000" });
    expect(sender.canSend).toBe(true);
  });
});
