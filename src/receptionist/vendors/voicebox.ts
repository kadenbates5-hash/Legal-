import type { SpeechToText, TextToSpeech, TranscriptionResult } from "../voice-agent.js";

/**
 * Adapter for Voicebox (https://github.com/jamiepine/voicebox), a
 * local-first, self-hosted STT/TTS service — not a hosted third-party
 * vendor. It still has to clear §5's due-diligence checklist (zero-
 * retention, no training on firm data, storage jurisdiction, subpoena-
 * compulsion risk, encryption) before `VoiceReceptionistSession` is wired
 * to it for a real call; this adapter only implements the interfaces so
 * that decision can be made independently of the receptionist state
 * machine, per voice-agent.ts's design.
 *
 * Voicebox exposes an unauthenticated REST API on localhost only
 * (default `http://127.0.0.1:17493`) — this class assumes it is reachable
 * at that address, not over the network.
 */
export interface VoiceboxConfig {
  baseUrl?: string;
  /** Voice profile id/name used for synthesis (see GET /profiles). */
  profile: string;
}

export class VoiceboxSpeechToText implements SpeechToText {
  #baseUrl: string;

  constructor(config: Pick<VoiceboxConfig, "baseUrl"> = {}) {
    this.#baseUrl = config.baseUrl ?? "http://127.0.0.1:17493";
  }

  async transcribe(audio: unknown): Promise<TranscriptionResult> {
    if (!(audio instanceof Blob)) {
      throw new TypeError("VoiceboxSpeechToText.transcribe expects a Blob of audio data");
    }

    const form = new FormData();
    form.append("audio", audio);
    form.append("model", "whisper-turbo");

    const response = await fetch(`${this.#baseUrl}/transcribe`, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(`Voicebox transcription failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { text?: string; confidence?: number };
    return body.confidence === undefined
      ? { text: body.text ?? "" }
      : { text: body.text ?? "", confidence: body.confidence };
  }
}

export class VoiceboxTextToSpeech implements TextToSpeech {
  #baseUrl: string;
  #profile: string;

  constructor(config: VoiceboxConfig) {
    this.#baseUrl = config.baseUrl ?? "http://127.0.0.1:17493";
    this.#profile = config.profile;
  }

  async synthesize(text: string): Promise<ArrayBuffer> {
    const response = await fetch(`${this.#baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, profile_id: this.#profile, language: "en" }),
    });
    if (!response.ok) {
      throw new Error(`Voicebox synthesis failed: ${response.status} ${response.statusText}`);
    }

    return response.arrayBuffer();
  }
}
