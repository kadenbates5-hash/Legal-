import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceboxSpeechToText, VoiceboxTextToSpeech } from "../src/integrations/voicebox.js";
import { VoiceReceptionistSession } from "../src/receptionist/voice-agent.js";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { Actor } from "../src/core/types.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("VoiceboxSpeechToText", () => {
  it("posts audio as multipart form data and parses the transcript", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ text: "hello there", confidence: 0.92 }), { status: 200 });
    }) as unknown as typeof fetch;

    const stt = new VoiceboxSpeechToText({ baseUrl: "http://127.0.0.1:17493" });
    const result = await stt.transcribe({ data: Buffer.from("audio bytes"), mimeType: "audio/wav" });

    expect(result).toEqual({ text: "hello there", confidence: 0.92 });
    expect(capturedUrl).toBe("http://127.0.0.1:17493/transcribe");
    expect(capturedBody).toBeInstanceOf(FormData);
  });

  it("omits confidence when the response doesn't include it", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ text: "hi" }), { status: 200 })) as unknown as typeof fetch;
    const stt = new VoiceboxSpeechToText();
    const result = await stt.transcribe({ data: Buffer.from("x"), mimeType: "audio/wav" });
    expect(result).toEqual({ text: "hi" });
  });

  it("throws a clear error for malformed audio input", async () => {
    const stt = new VoiceboxSpeechToText();
    await expect(stt.transcribe("not the right shape")).rejects.toThrow(/expects/);
    await expect(stt.transcribe({ data: "not a buffer", mimeType: "audio/wav" })).rejects.toThrow(/expects/);
  });

  it("surfaces a non-ok response as an error", async () => {
    global.fetch = vi.fn(async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const stt = new VoiceboxSpeechToText();
    await expect(stt.transcribe({ data: Buffer.from("x"), mimeType: "audio/wav" })).rejects.toThrow(/500/);
  });

  it("defaults to the local Voicebox port when no baseUrl is given", async () => {
    let capturedUrl: string | undefined;
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    }) as unknown as typeof fetch;
    const stt = new VoiceboxSpeechToText();
    await stt.transcribe({ data: Buffer.from("x"), mimeType: "audio/wav" });
    expect(capturedUrl).toBe("http://127.0.0.1:17493/transcribe");
  });
});

describe("VoiceboxTextToSpeech", () => {
  it("posts text to /generate and returns raw audio bytes", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string;
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as unknown as typeof fetch;

    const tts = new VoiceboxTextToSpeech({ baseUrl: "http://127.0.0.1:17493", profileId: "attorney-voice" });
    const audio = await tts.synthesize("Hello, thanks for calling.");

    expect(capturedUrl).toBe("http://127.0.0.1:17493/generate");
    expect(JSON.parse(capturedBody!)).toEqual({ text: "Hello, thanks for calling.", profile_id: "attorney-voice" });
    expect(Buffer.isBuffer(audio)).toBe(true);
    expect([...audio]).toEqual([1, 2, 3, 4]);
  });

  it("omits profile_id when none is configured", async () => {
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(new Uint8Array([]), { status: 200 });
    }) as unknown as typeof fetch;

    const tts = new VoiceboxTextToSpeech();
    await tts.synthesize("hi");
    expect(JSON.parse(capturedBody!)).toEqual({ text: "hi" });
  });

  it("surfaces a non-ok response as an error", async () => {
    global.fetch = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const tts = new VoiceboxTextToSpeech();
    await expect(tts.synthesize("hi")).rejects.toThrow(/400/);
  });
});

describe("VoiceReceptionistSession wired to the real Voicebox adapters", () => {
  const actor: Actor = { id: "r1", role: "receptionist" };

  it("drives a real conversation turn through the real router, using Voicebox for both directions", async () => {
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/generate")) return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
      if (url.endsWith("/transcribe")) return new Response(JSON.stringify({ text: "new client", confidence: 0.95 }), { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const router = new Router(accessControl, auditLog);
    const chatSession = new ReceptionistChatSession({ matterId: "m1", module: criminalLawModule, router, actor });
    const voice = new VoiceReceptionistSession({
      chatSession,
      stt: new VoiceboxSpeechToText(),
      tts: new VoiceboxTextToSpeech(),
    });

    const greetingAudio = await voice.greet();
    expect(Buffer.isBuffer(greetingAudio)).toBe(true);

    const turn = await voice.handleAudioTurn({ data: Buffer.from("caller audio"), mimeType: "audio/wav" });
    expect(turn.transcript).toBe("new client");
    expect(turn.misheard).toBe(false);
    expect(Buffer.isBuffer(turn.audioReply)).toBe(true);
  });
});
