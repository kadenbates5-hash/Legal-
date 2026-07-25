import { describe, expect, it } from "vitest";
import { BillingHoursStore } from "../src/core/billing-hours.js";

describe("BillingHoursStore", () => {
  it("logs an entry", () => {
    const store = new BillingHoursStore();
    const entry = store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 1.5, description: "Drafted motion" });
    expect(entry.hours).toBe(1.5);
    expect(entry.matterId).toBe("m1");
  });

  it("rejects zero or negative hours", () => {
    const store = new BillingHoursStore();
    expect(() => store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 0, description: "x" })).toThrow();
    expect(() => store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: -1, description: "x" })).toThrow();
  });

  it("rejects an empty description", () => {
    const store = new BillingHoursStore();
    expect(() => store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 1, description: "   " })).toThrow();
  });

  it("lists entries by matter and by actor", () => {
    const store = new BillingHoursStore();
    store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 1, description: "a" });
    store.log({ matterId: "m1", actorId: "a1", date: "2026-07-28", hours: 2, description: "b" });
    store.log({ matterId: "m2", actorId: "p1", date: "2026-07-29", hours: 3, description: "c" });
    expect(store.listByMatter("m1")).toHaveLength(2);
    expect(store.listByActor("p1")).toHaveLength(2);
  });

  it("deletes an entry", () => {
    const store = new BillingHoursStore();
    const entry = store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 1, description: "a" });
    store.delete(entry.id);
    expect(store.get(entry.id)).toBeUndefined();
  });

  it("round-trips through toSnapshot/fromSnapshot", () => {
    const store = new BillingHoursStore();
    store.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 1, description: "a" });
    const restored = BillingHoursStore.fromSnapshot(store.toSnapshot());
    expect(restored.listByMatter("m1")).toHaveLength(1);
    const next = restored.log({ matterId: "m1", actorId: "p1", date: "2026-07-29", hours: 1, description: "b" });
    expect(next.id).not.toBe("hrs_1");
  });
});
