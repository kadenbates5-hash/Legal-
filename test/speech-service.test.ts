import { describe, expect, it } from "vitest";
import { SpeechService } from "../src/review-ui/speech-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { TextToSpeech } from "../src/receptionist/voice-agent.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };
const system: Actor = { id: "system", role: "system" };
const client: Actor = { id: "c1", role: "client" };

/** Same fake-vendor pattern as test/voice-call-sessions.test.ts, but returning a real Buffer — SpeechService casts synthesize()'s result to one, so a realistic fake exercises that. */
class FakeTextToSpeech implements TextToSpeech {
  calls: string[] = [];
  async synthesize(text: string): Promise<unknown> {
    this.calls.push(text);
    return Buffer.from(`audio-for:${text}`);
  }
}

describe("SpeechService", () => {
  it("synthesizes text for every staff human role", async () => {
    const tts = new FakeTextToSpeech();
    const service = new SpeechService(tts);
    const audio = await service.synthesize(attorney, "Hello, this is Docket.");
    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(audio.toString()).toBe("audio-for:Hello, this is Docket.");
    expect(tts.calls).toEqual(["Hello, this is Docket."]);

    await service.synthesize(paralegal, "A second call.");
    // Receptionist is explicitly allowed — the Live Intake Demo's
    // script-preview use case is primarily theirs.
    await service.synthesize(receptionist, "A third call.");
    expect(tts.calls).toHaveLength(3);
  });

  it("denies the system credential and a client account", async () => {
    const service = new SpeechService(new FakeTextToSpeech());
    await expect(service.synthesize(system, "hi")).rejects.toThrow(AccessDeniedError);
    await expect(service.synthesize(client, "hi")).rejects.toThrow(AccessDeniedError);
  });

  it("refuses empty text", async () => {
    const service = new SpeechService(new FakeTextToSpeech());
    await expect(service.synthesize(attorney, "   ")).rejects.toThrow(/no text/i);
  });

  it("refuses text past the length cap", async () => {
    const service = new SpeechService(new FakeTextToSpeech());
    await expect(service.synthesize(attorney, "x".repeat(4001))).rejects.toThrow(/too long/i);
  });

  it("trims whitespace before synthesizing", async () => {
    const tts = new FakeTextToSpeech();
    const service = new SpeechService(tts);
    await service.synthesize(attorney, "  spaced out  ");
    expect(tts.calls).toEqual(["spaced out"]);
  });
});
