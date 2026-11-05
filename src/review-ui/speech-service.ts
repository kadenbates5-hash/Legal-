import { AccessDeniedError, type Actor } from "../core/types.js";
import type { TextToSpeech } from "../receptionist/voice-agent.js";

/**
 * Backs the "Listen" buttons scattered through the dashboard (a drafted
 * document's content, a chat/announcement message, a receptionist
 * script reply in the Live Intake Demo) rather than a standalone "type
 * anything, get audio" panel — every caller already has real text on
 * screen; this never takes dictation from a blank box. One shared
 * route over the same `TextToSpeech` interface `voice-agent.ts` already
 * depends on for real calls, so the actual vendor (Voicebox) needed no
 * changes at all — this is a second, much lower-stakes consumer of the
 * exact same seam.
 *
 * Open to every logged-in staff human — same "every staff role" meaning
 * as `messaging-service.ts`'s `requireHuman()`, not just paralegal/
 * attorney: a receptionist previewing how a script line actually sounds
 * in the Live Intake Demo is as legitimate a use as a paralegal having a
 * draft read back to them. Denied only to the `"system"` machine
 * credential, a `"client"` account (this isn't the client-facing voice
 * channel, which already has its own synthesis path through the
 * Twilio/Voicebox webhook handlers), and an unauthenticated/`"anonymous"`
 * caller.
 */
const MAX_TEXT_LENGTH = 4000;

function requireStaffHuman(actor: Actor): void {
  if (actor.role === "system" || actor.role === "client" || actor.role === "anonymous") {
    throw new AccessDeniedError(`reading text aloud is not available to role '${actor.role}'`);
  }
}

export class SpeechService {
  #tts: TextToSpeech;

  constructor(tts: TextToSpeech) {
    this.#tts = tts;
  }

  /**
   * Returns raw synthesized audio bytes. Narrows `TextToSpeech`'s opaque
   * `unknown` return the same way `server.ts`'s Twilio voice handlers
   * already do for a real call — `Buffer` is what every adapter actually
   * returns, the interface just doesn't promise that at the type level.
   */
  async synthesize(actor: Actor, text: string): Promise<Buffer> {
    requireStaffHuman(actor);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("there's no text to read aloud");
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw new Error(`text is too long to read aloud (${trimmed.length} characters, ${MAX_TEXT_LENGTH} max) — synthesizing a whole long document in one request isn't what this is for`);
    }
    return (await this.#tts.synthesize(trimmed)) as Buffer;
  }
}
