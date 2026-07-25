import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer, type TwilioVoiceConfig } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { VoiceCallSessions } from "../src/receptionist/voice-call-sessions.js";
import { AudioClipStore } from "../src/receptionist/audio-clip-store.js";
import type { SpeechToText, TextToSpeech, TranscriptionResult } from "../src/receptionist/voice-agent.js";

/** Decodes the "recording" bytes back to the caller's intended utterance — stands in for real Whisper transcription. */
class FakeSpeechToText implements SpeechToText {
  async transcribe(audio: unknown): Promise<TranscriptionResult> {
    const { data } = audio as { data: Buffer };
    return { text: data.toString("utf8") };
  }
}

class FakeTextToSpeech implements TextToSpeech {
  async synthesize(text: string): Promise<unknown> {
    return Buffer.from(text, "utf8");
  }
}

const TWILIO: TwilioVoiceConfig = { accountSid: "AC1", authToken: "twilio-auth-token", publicBaseUrl: "https://docket.example.com" };

function sign(url: string, formParams: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(formParams).sort()) data += key + formParams[key];
  return createHmac("sha1", TWILIO.authToken).update(data, "utf8").digest("base64");
}

function twilioPost(path: string, formParams: Record<string, string>, badSignature = false) {
  const url = `${TWILIO.publicBaseUrl}${path}`;
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-twilio-signature": badSignature ? "wrong" : sign(url, formParams),
    },
    body: new URLSearchParams(formParams).toString(),
  };
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`).exec(xml);
  if (!match) throw new Error(`no <${tag} ${attr}="..."> found in: ${xml}`);
  return match[1]!;
}

function extractPlayUrl(xml: string): string {
  const match = /<Play>([^<]*)<\/Play>/.exec(xml);
  if (!match) throw new Error(`no <Play> found in: ${xml}`);
  return match[1]!;
}

let server: Server;
let baseUrl: string;
const originalFetch = global.fetch;

beforeEach(async () => {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const voiceCalls = new VoiceCallSessions({
    accessControl,
    auditLog,
    module: criminalLawModule,
    stt: new FakeSpeechToText(),
    tts: new FakeTextToSpeech(),
  });
  const auth = new AuthService();
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    voiceCalls,
    audioClips: new AudioClipStore(),
    twilio: TWILIO,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Twilio voice webhook", () => {
  it("404s when the telephony integration isn't configured on the server", async () => {
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), new AuthService());
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const { port } = bareServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const res = await fetch(`${url}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA1" }));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it("rejects a webhook with a bad Twilio signature", async () => {
    const res = await fetch(`${baseUrl}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA1" }, true));
    expect(res.status).toBe(403);
  });

  it("rejects a webhook with no signature at all", async () => {
    const res = await fetch(`${baseUrl}/api/voice/twilio/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA1" }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it("answers an incoming call with Play+Record TwiML, and the played audio is fetchable", async () => {
    const res = await fetch(`${baseUrl}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/xml/);
    const xml = await res.text();
    expect(xml).toContain("<Record");

    const playUrl = extractPlayUrl(xml);
    const clipId = playUrl.split("/").pop()!;
    const audioRes = await fetch(`${baseUrl}/api/voice/audio/${clipId}`);
    expect(audioRes.status).toBe(200);
    const greetingText = await audioRes.text();
    expect(greetingText).toMatch(/new client|existing client/i);
  });

  it("drives a full turn: recording webhook downloads audio, transcribes, and replies", async () => {
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("api.twilio.com")) {
        return new Response(Buffer.from("new client", "utf8"), { status: 200 });
      }
      return originalFetch(urlStr, init);
    }) as unknown as typeof fetch;

    const incomingRes = await fetch(`${baseUrl}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA1" }));
    const incomingXml = await incomingRes.text();
    const recordingActionUrl = extractAttr(incomingXml, "Record", "action");
    const recordingPath = recordingActionUrl.replace(TWILIO.publicBaseUrl, "");

    const recordingForm = { CallSid: "CA1", RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1" };
    const res = await fetch(`${baseUrl}${recordingPath}`, twilioPost(recordingPath, recordingForm));
    expect(res.status).toBe(200);
    const xml = await res.text();

    const playUrl = extractPlayUrl(xml);
    const clipId = playUrl.split("/").pop()!;
    const audioRes = await fetch(`${baseUrl}/api/voice/audio/${clipId}`);
    const replyText = await audioRes.text();
    // "new client" should route into the criminal-law intake flow, not a mis-heard retry.
    expect(replyText).not.toMatch(/didn't catch that/i);
  });

  it("falls back to a Twilio-native error response if starting the call throws (e.g. Voicebox unreachable)", async () => {
    class ThrowingTextToSpeech implements TextToSpeech {
      async synthesize(): Promise<unknown> {
        throw new Error("simulated Voicebox connection failure");
      }
    }
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const failingVoiceCalls = new VoiceCallSessions({
      accessControl,
      auditLog,
      module: criminalLawModule,
      stt: new FakeSpeechToText(),
      tts: new ThrowingTextToSpeech(),
    });
    const failingServer = createReviewServer(new ReviewGateService(new WorkProductStore()), new AuthService(), {
      voiceCalls: failingVoiceCalls,
      audioClips: new AudioClipStore(),
      twilio: TWILIO,
    });
    await new Promise<void>((resolve) => failingServer.listen(0, resolve));
    const { port } = failingServer.address() as AddressInfo;
    const failingBaseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${failingBaseUrl}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA_fail" }));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Say>");
    expect(xml).toContain("<Hangup");

    await new Promise<void>((resolve) => failingServer.close(() => resolve()));
  });

  it("returns 404 for an unknown audio clip id", async () => {
    const res = await fetch(`${baseUrl}/api/voice/audio/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("serves audio clips without requiring a Docket login session", async () => {
    const res = await fetch(`${baseUrl}/api/voice/twilio/incoming`, twilioPost("/api/voice/twilio/incoming", { CallSid: "CA1" }));
    const xml = await res.text();
    const playUrl = extractPlayUrl(xml);
    const clipId = playUrl.split("/").pop()!;
    // No cookie attached at all.
    const audioRes = await fetch(`${baseUrl}/api/voice/audio/${clipId}`);
    expect(audioRes.status).toBe(200);
  });
});
