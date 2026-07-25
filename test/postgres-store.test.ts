import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresStateStore, type PostgresStateStore } from "../src/persistence/postgres-store.js";
import { loadSystemState, saveSystemState } from "../src/persistence/system-state.js";
import { WorkProduct } from "../src/core/review-gate.js";
import type { Actor } from "../src/core/types.js";

/**
 * Real integration tests against an actual Postgres instance (not a
 * mocked pg.Pool) — DATABASE_URL points at a local `docket_test`
 * database. Skips cleanly if no Postgres is reachable, so this suite
 * doesn't fail CI environments without a database available; it's a
 * genuine correctness check wherever one is.
 */
const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@127.0.0.1:5432/docket_test";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

async function isPostgresReachable(): Promise<boolean> {
  try {
    const store = await createPostgresStateStore({ connectionString: DATABASE_URL, key: "__reachability_check__" });
    await store.close();
    return true;
  } catch {
    return false;
  }
}

const reachable = await isPostgresReachable();
const describeIfReachable = reachable ? describe : describe.skip;

describeIfReachable("PostgresStateStore (real Postgres)", () => {
  let store: PostgresStateStore;
  const key = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  beforeEach(async () => {
    store = await createPostgresStateStore({ connectionString: DATABASE_URL, key });
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns the default value when nothing has been written yet for this key", async () => {
    const value = await store.read({ fallback: true });
    expect(value).toEqual({ fallback: true });
  });

  it("round-trips arbitrary JSON data, including nested structures", async () => {
    const data = { a: 1, b: ["x", "y"], c: { nested: true, list: [1, 2, 3] } };
    await store.write(data);
    expect(await store.read(null)).toEqual(data);
  });

  it("overwrites cleanly on a second write (no stale leftover data)", async () => {
    await store.write({ version: 1 });
    await store.write({ version: 2 });
    expect(await store.read({})).toEqual({ version: 2 });
  });

  it("keys are isolated from each other", async () => {
    const otherStore = await createPostgresStateStore({ connectionString: DATABASE_URL, key: `${key}_other` });
    try {
      await store.write({ owner: "first" });
      await otherStore.write({ owner: "second" });
      expect(await store.read(null)).toEqual({ owner: "first" });
      expect(await otherStore.read(null)).toEqual({ owner: "second" });
    } finally {
      await otherStore.close();
    }
  });

  it("is idempotent to call createPostgresStateStore repeatedly against the same database (CREATE TABLE IF NOT EXISTS)", async () => {
    const again = await createPostgresStateStore({ connectionString: DATABASE_URL, key });
    try {
      await store.write({ hello: "world" });
      expect(await again.read(null)).toEqual({ hello: "world" });
    } finally {
      await again.close();
    }
  });
});

describeIfReachable("system-state persistence over real Postgres", () => {
  let key: string;
  let store: PostgresStateStore;

  beforeEach(async () => {
    key = `system_state_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    store = await createPostgresStateStore({ connectionString: DATABASE_URL, key });
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists and reloads a full working state across separate load calls, simulating a process restart", async () => {
    const state = await loadSystemState(store);
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft" }, state.auditLog);
    state.workProductStore.register(wp);
    wp.submitForReview(paralegal);
    state.utilization.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "x" });
    state.auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });

    await saveSystemState(store, state);

    // Simulate a fresh process: a brand-new StateStore instance, nothing shared with `state` above.
    const freshStore = await createPostgresStateStore({ connectionString: DATABASE_URL, key });
    try {
      const reloaded = await loadSystemState(freshStore);
      expect(reloaded.workProductStore.get("wp1")?.status).toBe("pending_review");
      expect(reloaded.utilization.all()).toHaveLength(1);
      expect(reloaded.auditLog.count()).toBeGreaterThan(0);
      expect(reloaded.auth.hasAnyUsers()).toBe(true);

      // Reloaded objects are still fully functional, rule-enforcing ones — not just replayed JSON.
      reloaded.workProductStore.get("wp1")!.approve(attorney);
      expect(reloaded.workProductStore.get("wp1")!.status).toBe("approved");
      expect(() => reloaded.auth.login("attorney1", "wrong-password", false)).toThrow();
    } finally {
      await freshStore.close();
    }
  });

  it("loads an empty state cleanly from a fresh key", async () => {
    const state = await loadSystemState(store);
    expect(state.workProductStore.listAll()).toHaveLength(0);
    expect(state.auditLog.count()).toBe(0);
    expect(state.auth.hasAnyUsers()).toBe(false);
  });
});
