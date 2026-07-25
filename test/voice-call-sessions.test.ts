import { describe, expect, it } from "vitest";
import { VoiceCallSessions } from "../src/receptionist/voice-call-sessions.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { SpeechToText, TextToSpeech, TranscriptionResult } from "../src/receptionist/voice-agent.js";

/** Same fake-vendor pattern as test/voice-agent.test.ts — `audio` is the caller's intended utterance as a string. */
class FakeSpeechToText implements SpeechToText {
  async transcribe(audio: unknown): Promise<TranscriptionResult> {
    return { text: String(audio) };
  }
}

class FakeTextToSpeech implements TextToSpeech {
  async synthesize(text: string): Promise<unknown> {
    return { kind: "audio", spokenText: text };
  }
}

function makeSessions() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  return new VoiceCallSessions({
    accessControl,
    auditLog,
    module: criminalLawModule,
    stt: new FakeSpeechToText(),
    tts: new FakeTextToSpeech(),
  });
}

describe("VoiceCallSessions", () => {
  it("starts a call and returns synthesized greeting audio", async () => {
    const sessions = makeSessions();
    const audio = (await sessions.start("CA123")) as { spokenText: string };
    expect(audio.spokenText).toMatch(/new client|existing client/i);
  });

  it("drives a turn through the real router for an in-progress call", async () => {
    const sessions = makeSessions();
    await sessions.start("CA123");
    const turn = await sessions.handleTurn("CA123", "new client");
    expect(turn.misheard).toBe(false);
    expect(turn.done).toBe(false);
  });

  it("throws for an unknown call id", async () => {
    const sessions = makeSessions();
    await expect(sessions.handleTurn("nope", "hi")).rejects.toThrow(/no voice call session/);
  });

  it("prunes the session once the conversation is done", async () => {
    const sessions = makeSessions();
    await sessions.start("CA123");
    let turn = await sessions.handleTurn("CA123", "opt out");
    // Drive to completion if the first opt-out signal doesn't immediately end it — mirror voice-agent.test.ts's escalation flow expectations loosely by looping until done or a bound.
    let guard = 0;
    while (!turn.done && guard < 5) {
      turn = await sessions.handleTurn("CA123", "opt out");
      guard++;
    }
    expect(turn.done).toBe(true);
    await expect(sessions.handleTurn("CA123", "hi")).rejects.toThrow(/no voice call session/);
  });

  it("end() removes a session even mid-conversation", async () => {
    const sessions = makeSessions();
    await sessions.start("CA123");
    sessions.end("CA123");
    await expect(sessions.handleTurn("CA123", "hi")).rejects.toThrow(/no voice call session/);
  });

  it("keeps concurrent calls isolated — ending one doesn't affect the other", async () => {
    const sessions = makeSessions();
    await sessions.start("CA1");
    await sessions.start("CA2");
    await sessions.handleTurn("CA1", "new client");
    sessions.end("CA1");

    await expect(sessions.handleTurn("CA1", "hi")).rejects.toThrow(/no voice call session/);
    // CA2 never touched CA1's session, so it should still be live.
    const turn2 = await sessions.handleTurn("CA2", "existing client");
    expect(turn2.misheard).toBe(false);
  });
});
