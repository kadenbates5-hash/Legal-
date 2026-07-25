import { describe, expect, it, vi } from "vitest";
import { AudioClipStore } from "../src/receptionist/audio-clip-store.js";

describe("AudioClipStore", () => {
  it("stores and retrieves a clip by id", () => {
    const store = new AudioClipStore();
    const id = store.store(Buffer.from("hello"), "audio/wav");
    const clip = store.get(id);
    expect(clip?.data.toString()).toBe("hello");
    expect(clip?.contentType).toBe("audio/wav");
  });

  it("returns undefined for an unknown id", () => {
    const store = new AudioClipStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("expires a clip after its TTL", () => {
    vi.useFakeTimers();
    try {
      const store = new AudioClipStore({ ttlMs: 1000 });
      const id = store.store(Buffer.from("hello"), "audio/wav");
      expect(store.get(id)).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(store.get(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every clip a distinct, unguessable id", () => {
    const store = new AudioClipStore();
    const id1 = store.store(Buffer.from("a"), "audio/wav");
    const id2 = store.store(Buffer.from("b"), "audio/wav");
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThanOrEqual(32);
  });
});
