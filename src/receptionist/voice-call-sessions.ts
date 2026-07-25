import { ReceptionistChatSession } from "./chat-agent.js";
import { VoiceReceptionistSession, type SpeechToText, type TextToSpeech, type VoiceTurnResult } from "./voice-agent.js";
import { Router } from "../core/router.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
import type { FirmConfig } from "../config/firm-config.js";
import type { UtilizationTracker } from "../core/utilization.js";

/**
 * Real-call analogue of `review-ui/intake-demo.ts`'s `IntakeDemoSessions`:
 * one `VoiceReceptionistSession` per live call, keyed by whatever call
 * identifier the telephony vendor uses (Twilio's `CallSid`, for the one
 * vendor wired in today — see `src/integrations/twilio-voice.ts`). This
 * class knows nothing about Twilio; it's the vendor-agnostic seam a
 * different carrier integration could reuse.
 *
 * The receptionist actor for a real inbound call isn't a logged-in human
 * — it's the voice line itself, fixed to role `"receptionist"` the same
 * way the rest of this system scopes that role.
 */
const VOICE_LINE_ACTOR: Actor = { id: "voice-line", role: "receptionist" };

export class VoiceCallSessions {
  #sessions = new Map<string, VoiceReceptionistSession>();
  #router: Router;
  #module: PracticeAreaModule;
  #stt: SpeechToText;
  #tts: TextToSpeech;
  #utilization: UtilizationTracker | undefined;
  #firmConfig: FirmConfig | undefined;

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    module: PracticeAreaModule;
    stt: SpeechToText;
    tts: TextToSpeech;
    utilization?: UtilizationTracker;
    firmConfig?: FirmConfig;
  }) {
    this.#router = new Router(params.accessControl, params.auditLog);
    this.#module = params.module;
    this.#stt = params.stt;
    this.#tts = params.tts;
    this.#utilization = params.utilization;
    this.#firmConfig = params.firmConfig;
  }

  /** Starts a new call session and returns the synthesized greeting audio to play. */
  async start(callId: string): Promise<unknown> {
    const chatSession = new ReceptionistChatSession({
      matterId: `call_${callId}`,
      module: this.#module,
      router: this.#router,
      actor: VOICE_LINE_ACTOR,
      ...(this.#utilization ? { utilization: this.#utilization } : {}),
      ...(this.#firmConfig ? { firmConfig: this.#firmConfig } : {}),
    });
    const voiceSession = new VoiceReceptionistSession({ chatSession, stt: this.#stt, tts: this.#tts });
    this.#sessions.set(callId, voiceSession);
    return voiceSession.greet();
  }

  /** One caller utterance in, one spoken reply out — see `VoiceReceptionistSession.handleAudioTurn`. Prunes the session once the conversation ends. */
  async handleTurn(callId: string, audio: unknown): Promise<VoiceTurnResult> {
    const session = this.#sessions.get(callId);
    if (!session) {
      throw new Error(`no voice call session '${callId}'`);
    }
    const result = await session.handleAudioTurn(audio);
    if (result.done) {
      this.#sessions.delete(callId);
    }
    return result;
  }

  /** For a carrier-side hangup/error that ends the call before `done` is ever reached — avoids leaking a session. */
  end(callId: string): void {
    this.#sessions.delete(callId);
  }
}
