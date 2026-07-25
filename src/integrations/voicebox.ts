import type { SpeechToText, TextToSpeech, TranscriptionResult } from "../receptionist/voice-agent.js";

/**
 * Voicebox (https://voicebox.sh) STT/TTS adapter — the real vendor behind
 * `voice-agent.ts`'s vendor-agnostic `SpeechToText`/`TextToSpeech`
 * interfaces (§8 build order step 6's remaining piece).
 *
 * Voicebox is architecturally different from a cloud STT/TTS vendor: it's
 * a local, open-source voice studio (Whisper for transcription, cloned
 * voices for synthesis) that runs its own REST API on the same machine
 * (default `http://127.0.0.1:17493`), not a hosted service you call with
 * an API key over the public internet. That has real implications worth
 * being explicit about rather than papering over:
 *
 *  - §5's due-diligence checklist (zero-retention, no training on firm
 *    data, storage jurisdiction, subpoena risk) is close to moot here in
 *    the strongest possible sense: audio never leaves the machine running
 *    Voicebox, so there's no third-party retention/training/jurisdiction
 *    surface to review in the first place — but that's *because* nothing
 *    is a managed vendor with an SLA, not a substitute for one.
 *  - Docket (or whatever process handles real calls) and the Voicebox
 *    process must be co-located or reachable over a trusted private
 *    network — there's no per-request credential model to lean on the way
 *    a cloud API key gives you. `baseUrl` is configurable specifically so
 *    this isn't hardcoded to localhost, but exposing Voicebox beyond
 *    localhost is a network-security decision this class doesn't make for
 *    you.
 *  - It's a young, single-machine, single-process tool — not something
 *    with the concurrency/uptime guarantees a live phone line needs. If
 *    that changes, this file is the only place that needs to change
 *    (that's the point of `SpeechToText`/`TextToSpeech` staying vendor-
 *    agnostic).
 *
 * The exact `/transcribe` request/response shape below is written against
 * Voicebox's own interactive API docs (served by the running app at
 * `<baseUrl>/docs`) and its public docs site — but this sandbox's network
 * policy blocked fetching `docs.voicebox.sh` directly while writing this,
 * so treat the STT endpoint path/payload as best-effort and confirm
 * against a running instance's `/docs` before pointing this at a real
 * call. `/generate` (TTS) is the one endpoint documented in enough
 * detail elsewhere to be confident about.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:17493";

/** What this adapter expects `SpeechToText.transcribe(audio)` to be called with — `audio` is `unknown` at the interface level so the caller (whatever captures real call audio) and this adapter have to agree on a concrete shape out-of-band. */
export interface VoiceboxAudioInput {
  /** Raw audio bytes (whatever container/codec Voicebox's transcription endpoint accepts — see the class doc comment on the STT path's uncertainty). */
  data: Buffer;
  mimeType: string;
}

function asVoiceboxAudioInput(audio: unknown): VoiceboxAudioInput {
  if (
    typeof audio !== "object" ||
    audio === null ||
    !Buffer.isBuffer((audio as { data?: unknown }).data) ||
    typeof (audio as { mimeType?: unknown }).mimeType !== "string"
  ) {
    throw new Error("VoiceboxSpeechToText.transcribe() expects { data: Buffer, mimeType: string }");
  }
  return audio as VoiceboxAudioInput;
}

export class VoiceboxSpeechToText implements SpeechToText {
  #baseUrl: string;

  constructor(params?: { baseUrl?: string }) {
    this.#baseUrl = (params?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async transcribe(audio: unknown): Promise<TranscriptionResult> {
    const input = asVoiceboxAudioInput(audio);
    const form = new FormData();
    form.append("file", new Blob([input.data], { type: input.mimeType }), "audio");

    const res = await fetch(`${this.#baseUrl}/transcribe`, { method: "POST", body: form });
    if (!res.ok) {
      throw new Error(`Voicebox transcription request failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { text?: string; confidence?: number };
    if (typeof body.text !== "string") {
      throw new Error("Voicebox transcription response did not include text");
    }
    return typeof body.confidence === "number" ? { text: body.text, confidence: body.confidence } : { text: body.text };
  }
}

export class VoiceboxTextToSpeech implements TextToSpeech {
  #baseUrl: string;
  #profileId: string | undefined;

  constructor(params?: { baseUrl?: string; profileId?: string }) {
    this.#baseUrl = (params?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#profileId = params?.profileId;
  }

  /** Returns raw synthesized audio bytes — the receptionist voice channel treats this as opaque (`unknown`) and hands it to whatever plays audio back to the caller. */
  async synthesize(text: string): Promise<Buffer> {
    const res = await fetch(`${this.#baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(this.#profileId ? { profile_id: this.#profileId } : {}) }),
    });
    if (!res.ok) {
      throw new Error(`Voicebox synthesis request failed (${res.status}): ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
