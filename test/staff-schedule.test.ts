import { describe, expect, it } from "vitest";
import { StaffScheduleStore } from "../src/core/staff-schedule.js";

describe("StaffScheduleStore", () => {
  it("upserts a single entry per actor/date pair", () => {
    const store = new StaffScheduleStore();
    const first = store.setEntry("a1", "2026-07-28", "in_office");
    const second = store.setEntry("a1", "2026-07-28", "remote", "working from home");
    expect(second.id).toBe(first.id);
    expect(store.listForActor("a1")).toHaveLength(1);
    expect(store.listForActor("a1")[0]!.status).toBe("remote");
  });

  it("lists an actor's entries sorted by date", () => {
    const store = new StaffScheduleStore();
    store.setEntry("a1", "2026-07-30", "in_office");
    store.setEntry("a1", "2026-07-28", "remote");
    const entries = store.listForActor("a1");
    expect(entries.map((e) => e.date)).toEqual(["2026-07-28", "2026-07-30"]);
  });

  it("lists everyone's entry for a given date", () => {
    const store = new StaffScheduleStore();
    store.setEntry("a1", "2026-07-28", "in_office");
    store.setEntry("p1", "2026-07-28", "remote");
    store.setEntry("p1", "2026-07-29", "out");
    const entries = store.listForDate("2026-07-28");
    expect(entries.map((e) => e.actorId).sort()).toEqual(["a1", "p1"]);
  });

  it("removes an entry", () => {
    const store = new StaffScheduleStore();
    store.setEntry("a1", "2026-07-28", "in_office");
    store.removeEntry("a1", "2026-07-28");
    expect(store.listForActor("a1")).toHaveLength(0);
  });

  it("round-trips through toSnapshot/fromSnapshot", () => {
    const store = new StaffScheduleStore();
    store.setEntry("a1", "2026-07-28", "in_office");
    store.setEntry("p1", "2026-07-28", "remote", "wfh");
    const restored = StaffScheduleStore.fromSnapshot(store.toSnapshot());
    expect(restored.listForDate("2026-07-28")).toHaveLength(2);
    const next = restored.setEntry("r1", "2026-07-29", "out");
    expect(next.id).not.toBe("sched_1");
  });
});
