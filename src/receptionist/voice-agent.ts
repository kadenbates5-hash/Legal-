import type { ReceptionistChatSession } from "./chat-agent.js";

/**
 * Voice channel for the receptionist agent (§8 build order step 6):
 * "same triage logic across both" channels per §2. This wraps the exact
 * same `ReceptionistChatSession` state machine used by chat — it adds
 * nothing to escalation/access-control/routing, only the audio boundary
 * and the handling voice specifically needs that text doesn't (mis-heard
 * or silent input).
 *
 * `SpeechToText`/`TextToSpeech` are intentionally vendor-agnostic
 * interfaces, not a concrete provider integration: §5's vendor due-
 * diligence checklist (zero-retention, no training on firm data, storage
 * jurisdiction, subpoena-compulsion risk, encryption) has to be cleared
 * for whichever STT/TTS vendor is chosen before this touches a real call,
 * and that choice shouldn't leak into the receptionist state machine.
 */
export interface TranscriptionResult {
  text: string;
  /** 0..1 confidence from the STT provider, if it exposes one. */
  confidence?: number;
}

export interface SpeechToText {
  transcribe(audio: unknown): Promise<TranscriptionResult>;
}

export interface TextToSpeech {
  synthesize(text: string): Promise<unknown>;
}

/** Below this confidence, treat the turn as mis-heard rather than act on a guess. */
const LOW_CONFIDENCE_THRESHOLD = 0.55;

const DIDNT_CATCH_THAT = "Sorry, I didn't catch that — could you say that again?";

export interface VoiceTurnResult {
  transcript: string;
  replyText: string;
  audioReply: unknown;
  done: boolean;
  /** True when this turn was a mis-hearing/silence handoff, not a real conversational turn. */
  misheard: boolean;
}

export class VoiceReceptionistSession {
  #chatSession: ReceptionistChatSession;
  #stt: SpeechToText;
  #tts: TextToSpeech;

  constructor(params: { chatSession: ReceptionistChatSession; stt: SpeechToText; tts: TextToSpeech }) {
    this.#chatSession = params.chatSession;
    this.#stt = params.stt;
    this.#tts = params.tts;
  }

  async greet(): Promise<unknown> {
    return this.#tts.synthesize(this.#chatSession.greet());
  }

  /**
   * One caller utterance in, one spoken reply out. Over-escalating on a
   * bad transcription is the safe failure mode (same principle as
   * signal-extraction.ts) — rather than acting on a low-confidence or
   * empty transcript, this asks the caller to repeat themselves without
   * advancing any state.
   */
  async handleAudioTurn(audio: unknown): Promise<VoiceTurnResult> {
    const { text, confidence } = await this.#stt.transcribe(audio);

    if (!text.trim() || (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD)) {
      return {
        transcript: text,
        replyText: DIDNT_CATCH_THAT,
        audioReply: await this.#tts.synthesize(DIDNT_CATCH_THAT),
        done: false,
        misheard: true,
      };
    }

    const { reply, done } = this.#chatSession.handleMessage(text);
    return {
      transcript: text,
      replyText: reply,
      audioReply: await this.#tts.synthesize(reply),
      done,
      misheard: false,
    };
  }
}
