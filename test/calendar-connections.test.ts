import { describe, expect, it } from "vitest";
import { CalendarConnectionStore } from "../src/core/calendar-connections.js";

describe("CalendarConnectionStore", () => {
  it("stores and retrieves a connection by actorId", () => {
    const store = new CalendarConnectionStore();
    store.set({ actorId: "a1", refreshToken: "refresh1", connectedEmail: "alice@example.com", connectedAt: "2026-01-01T00:00:00Z" });
    expect(store.get("a1")).toMatchObject({ refreshToken: "refresh1", connectedEmail: "alice@example.com" });
  });

  it("returns undefined for an actor with no connection", () => {
    const store = new CalendarConnectionStore();
    expect(store.get("a1")).toBeUndefined();
  });

  it("removes a connection", () => {
    const store = new CalendarConnectionStore();
    store.set({ actorId: "a1", refreshToken: "refresh1", connectedEmail: undefined, connectedAt: "2026-01-01T00:00:00Z" });
    store.remove("a1");
    expect(store.get("a1")).toBeUndefined();
  });

  it("setting a new connection for the same actor replaces the old one", () => {
    const store = new CalendarConnectionStore();
    store.set({ actorId: "a1", refreshToken: "old", connectedEmail: undefined, connectedAt: "2026-01-01T00:00:00Z" });
    store.set({ actorId: "a1", refreshToken: "new", connectedEmail: "alice@example.com", connectedAt: "2026-02-01T00:00:00Z" });
    expect(store.get("a1")?.refreshToken).toBe("new");
  });

  it("round-trips through a snapshot", () => {
    const store = new CalendarConnectionStore();
    store.set({ actorId: "a1", refreshToken: "refresh1", connectedEmail: "alice@example.com", connectedAt: "2026-01-01T00:00:00Z" });
    store.set({ actorId: "a2", refreshToken: "refresh2", connectedEmail: undefined, connectedAt: "2026-01-02T00:00:00Z" });

    const restored = CalendarConnectionStore.fromSnapshot(store.toSnapshot());
    expect(restored.get("a1")).toEqual(store.get("a1"));
    expect(restored.get("a2")).toEqual(store.get("a2"));
  });
});
