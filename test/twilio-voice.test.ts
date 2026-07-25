import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyTwilioSignature,
  twimlPlayThenRecord,
  twimlPlayThenHangup,
  downloadTwilioRecording,
} from "../src/integrations/twilio-voice.js";

function computeSignature(authToken: string, url: string, formParams: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(formParams).sort()) data += key + formParams[key];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://docket.example.com/api/voice/twilio/incoming";
  const formParams = { CallSid: "CA123", From: "+15551234567" };

  it("accepts a correctly computed signature", () => {
    const signature = computeSignature(authToken, url, formParams);
    expect(verifyTwilioSignature({ authToken, url, formParams, signature })).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const signature = computeSignature(authToken, url, formParams);
    expect(verifyTwilioSignature({ authToken, url, formParams: { ...formParams, CallSid: "CA999" }, signature })).toBe(false);
  });

  it("rejects a missing signature outright", () => {
    expect(verifyTwilioSignature({ authToken, url, formParams, signature: undefined })).toBe(false);
  });

  it("rejects the wrong auth token", () => {
    const signature = computeSignature(authToken, url, formParams);
    expect(verifyTwilioSignature({ authToken: "wrong-token", url, formParams, signature })).toBe(false);
  });

  it("rejects a signature computed against a different URL", () => {
    const signature = computeSignature(authToken, "https://docket.example.com/api/voice/twilio/other", formParams);
    expect(verifyTwilioSignature({ authToken, url, formParams, signature })).toBe(false);
  });
});

describe("TwiML builders", () => {
  it("builds Play+Record TwiML", () => {
    const xml = twimlPlayThenRecord({ audioUrl: "https://docket.example.com/api/voice/audio/abc", recordingActionUrl: "https://docket.example.com/api/voice/twilio/CA1/recording" });
    expect(xml).toContain("<Play>https://docket.example.com/api/voice/audio/abc</Play>");
    expect(xml).toContain('action="https://docket.example.com/api/voice/twilio/CA1/recording"');
    expect(xml).toContain("<Record");
  });

  it("builds Play+Hangup TwiML", () => {
    const xml = twimlPlayThenHangup({ audioUrl: "https://docket.example.com/api/voice/audio/abc" });
    expect(xml).toContain("<Play>https://docket.example.com/api/voice/audio/abc</Play>");
    expect(xml).toContain("<Hangup");
  });

  it("escapes XML-unsafe characters in URLs", () => {
    const xml = twimlPlayThenRecord({ audioUrl: "https://docket.example.com/api/voice/audio/a&b", recordingActionUrl: "https://docket.example.com/x?a=1&b=2" });
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("a=1&amp;b=2");
  });
});

describe("downloadTwilioRecording", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("appends .wav and sends Basic auth with the account credentials", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init?.headers as Record<string, string>)?.["Authorization"];
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const buffer = await downloadTwilioRecording({
      recordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1",
      accountSid: "AC1",
      authToken: "token1",
    });

    expect(capturedUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.wav");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("AC1:token1").toString("base64")}`);
    expect([...buffer]).toEqual([1, 2, 3]);
  });

  it("doesn't double-append .wav if already present", async () => {
    let capturedUrl: string | undefined;
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(new Uint8Array([]), { status: 200 });
    }) as unknown as typeof fetch;

    await downloadTwilioRecording({ recordingUrl: "https://api.twilio.com/x/RE1.wav", accountSid: "AC1", authToken: "token1" });
    expect(capturedUrl).toBe("https://api.twilio.com/x/RE1.wav");
  });

  it("throws on a non-ok response", async () => {
    global.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(
      downloadTwilioRecording({ recordingUrl: "https://api.twilio.com/x/RE1", accountSid: "AC1", authToken: "token1" }),
    ).rejects.toThrow(/404/);
  });
});
