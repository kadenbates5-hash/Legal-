import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceboxSpeechToText, VoiceboxTextToSpeech } from "../src/receptionist/vendors/voicebox.js";

describe("Voicebox adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("VoiceboxSpeechToText", () => {
    it("posts audio to /transcribe and returns text/confidence", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ text: "I'm a new client", confidence: 0.92 }), { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const stt = new VoiceboxSpeechToText({ baseUrl: "http://127.0.0.1:17493" });
      const result = await stt.transcribe(new Blob([new Uint8Array([1, 2, 3])]));

      expect(result).toEqual({ text: "I'm a new client", confidence: 0.92 });
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:17493/transcribe", expect.objectContaining({ method: "POST" }));
    });

    it("rejects non-Blob input rather than silently coercing it", async () => {
      const stt = new VoiceboxSpeechToText();
      await expect(stt.transcribe("not-a-blob")).rejects.toThrow(TypeError);
    });

    it("throws on a non-ok response instead of returning a partial transcript", async () => {
      globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
      const stt = new VoiceboxSpeechToText();
      await expect(stt.transcribe(new Blob([new Uint8Array([1])]))).rejects.toThrow(/500/);
    });
  });

  describe("VoiceboxTextToSpeech", () => {
    it("posts text and profile to /generate and returns audio bytes", async () => {
      const audioBytes = new Uint8Array([9, 9, 9]).buffer;
      const fetchMock = vi.fn(async () => new Response(audioBytes, { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const tts = new VoiceboxTextToSpeech({ baseUrl: "http://127.0.0.1:17493", profile: "Morgan" });
      const result = await tts.synthesize("Deploy complete.");

      expect(new Uint8Array(result)).toEqual(new Uint8Array(audioBytes));
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:17493/generate");
      expect(JSON.parse(init.body as string)).toEqual({ text: "Deploy complete.", profile_id: "Morgan", language: "en" });
    });

    it("throws on a non-ok response", async () => {
      globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
      const tts = new VoiceboxTextToSpeech({ profile: "Morgan" });
      await expect(tts.synthesize("hi")).rejects.toThrow(/503/);
    });
  });
});
