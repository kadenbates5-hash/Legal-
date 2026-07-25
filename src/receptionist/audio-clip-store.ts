import { randomBytes } from "node:crypto";

/**
 * Ephemeral in-memory store for synthesized audio that a telephony vendor
 * needs to fetch by URL (Twilio's `<Play>` verb takes a URL, not inline
 * bytes) rather than receive directly in a webhook response. Deliberately
 * not persisted to `system-state.ts` — a clip is only ever the audio for
 * one turn of one live call, gone the moment that turn is served or a
 * short TTL elapses, same "throwaway, not a real record" reasoning as
 * `intake-demo.ts`'s sessions.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface StoredClip {
  data: Buffer;
  contentType: string;
  expiresAt: number;
}

export class AudioClipStore {
  #clips = new Map<string, StoredClip>();
  #ttlMs: number;

  constructor(params?: { ttlMs?: number }) {
    this.#ttlMs = params?.ttlMs ?? DEFAULT_TTL_MS;
  }

  store(data: Buffer, contentType: string): string {
    this.#sweep();
    const id = randomBytes(16).toString("hex");
    this.#clips.set(id, { data, contentType, expiresAt: Date.now() + this.#ttlMs });
    return id;
  }

  get(id: string): { data: Buffer; contentType: string } | undefined {
    this.#sweep();
    const clip = this.#clips.get(id);
    return clip ? { data: clip.data, contentType: clip.contentType } : undefined;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, clip] of this.#clips) {
      if (clip.expiresAt <= now) this.#clips.delete(id);
    }
  }
}
