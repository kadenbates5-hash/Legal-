import { describe, expect, it } from "vitest";
import { VoiceReceptionistSession, type SpeechToText, type TextToSpeech, type TranscriptionResult } from "../src/receptionist/voice-agent.js";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { Actor } from "../src/core/types.js";

const actor: Actor = { id: "r1", role: "receptionist" };

/**
 * Test doubles standing in for a real STT/TTS vendor. `audio` is just the
 * caller's intended utterance as a string (with an optional confidence
 * suffix like "|0.3") — there's no real audio in this environment, and the
 * point of these tests is to prove the voice layer drives the exact same
 * router/escalation state machine as chat, not to test a vendor SDK.
 */
class FakeSpeechToText implements SpeechToText {
  async transcribe(audio: unknown): Promise<TranscriptionResult> {
    const raw = String(audio);
    const [text, confidenceStr] = raw.split("|");
    return {
      text: text ?? "",
      confidence: confidenceStr !== undefined ? Number(confidenceStr) : undefined,
    };
  }
}

class FakeTextToSpeech implements TextToSpeech {
  async synthesize(text: string): Promise<unknown> {
    return { kind: "audio", spokenText: text };
  }
}

function makeVoiceSession() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const router = new Router(accessControl, auditLog);
  const chatSession = new ReceptionistChatSession({ matterId: "m1", module: criminalLawModule, router, actor });
  return new VoiceReceptionistSession({ chatSession, stt: new FakeSpeechToText(), tts: new FakeTextToSpeech() });
}

describe("voice receptionist session", () => {
  it("speaks the same greeting text the chat channel uses", async () => {
    const voice = makeVoiceSession();
    const audioGreeting = (await voice.greet()) as { spokenText: string };
    expect(audioGreeting.spokenText).toMatch(/new client|existing client/i);
  });

  it("drives the same router/escalation state machine as chat — emergency triggers still preempt", async () => {
    const voice = makeVoiceSession();
    const result = await voice.handleAudioTurn("I'm currently in jail and need help");
    expect(result.replyText).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
    expect((result.audioReply as { spokenText: string }).spokenText).toBe(result.replyText);
  });

  it("asks the caller to repeat themselves on an empty transcript, without advancing state", async () => {
    const voice = makeVoiceSession();
    const result = await voice.handleAudioTurn("");
    expect(result.misheard).toBe(true);
    expect(result.replyText).toMatch(/didn't catch that/i);
    expect(result.done).toBe(false);
  });

  it("asks the caller to repeat themselves on a low-confidence transcription", async () => {
    const voice = makeVoiceSession();
    const result = await voice.handleAudioTurn("mumble mumble|0.2");
    expect(result.misheard).toBe(true);
    expect(result.replyText).toMatch(/didn't catch that/i);
  });

  it("does not treat a mis-heard turn as an answer — state is unchanged for the next real turn", async () => {
    const voice = makeVoiceSession();
    await voice.handleAudioTurn("mumble mumble|0.2"); // misheard, should not consume the caller-type gate
    const real = await voice.handleAudioTurn("I'm a new client|0.95");
    expect(real.misheard).toBe(false);
    expect(real.replyText).toMatch(/recorded/i); // consent gate — proves caller-type was captured on this turn
  });

  it("proceeds normally on a high-confidence transcript", async () => {
    const voice = makeVoiceSession();
    const result = await voice.handleAudioTurn("I'm a new client|0.9");
    expect(result.misheard).toBe(false);
    expect(result.done).toBe(false);
  });

  it("treats an undefined confidence (vendor doesn't report one) as acceptable", async () => {
    const voice = makeVoiceSession();
    const result = await voice.handleAudioTurn("I'm a new client");
    expect(result.misheard).toBe(false);
  });
});
