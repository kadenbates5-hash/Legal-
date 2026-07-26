import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog } from "../src/core/audit.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { loadSystemState, saveSystemState } from "../src/persistence/system-state.js";
import { readJsonFile, writeJsonFile } from "../src/persistence/json-file-store.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

describe("domain object snapshot round-trips", () => {
  it("AuditLog preserves entries, order, and sequence numbers exactly", () => {
    const log = new AuditLog();
    log.append({ actor: paralegal, matterId: "m1", action: "a", detail: "first" });
    log.append({ actor: attorney, matterId: "m1", action: "b", detail: undefined });

    const restored = AuditLog.fromSnapshot(log.toSnapshot());
    expect(restored.count()).toBe(2);
    expect(restored.read("attorney")).toEqual(log.read("attorney"));
  });

  it("UtilizationTracker preserves entries and the id counter (no id collisions after reload)", () => {
    const tracker = new UtilizationTracker();
    const e1 = tracker.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "x" });
    tracker.finish(e1.id, "completed");

    const restored = UtilizationTracker.fromSnapshot(tracker.toSnapshot());
    expect(restored.all()).toEqual(tracker.all());

    const e2 = restored.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "y" });
    expect(e2.id).not.toBe(e1.id);
  });

  it("WorkProduct round-trips exact status, content, flags, and history through a snapshot", () => {
    const auditLog = new AuditLog();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "v1" }, auditLog);
    wp.reviseDraft(paralegal, "v2");
    wp.submitForReview(paralegal);
    wp.requestRevision(attorney, "fix caption");
    wp.reviseDraft(paralegal, "v3");
    wp.submitForReview(paralegal);
    wp.approve(attorney);

    const snapshot = wp.toSnapshot();
    const restored = WorkProduct.fromSnapshot(snapshot, auditLog);

    expect(restored.status).toBe("approved");
    expect(restored.content).toBe("v3");
    expect(restored.history).toEqual(wp.history);
    expect([...restored.flags]).toEqual([...wp.flags]);
  });

  it("a rehydrated approved work product still enforces the content lock — business rules survive, not just data", () => {
    const auditLog = new AuditLog();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "final" }, auditLog);
    wp.submitForReview(paralegal);
    wp.approve(attorney);

    const restored = WorkProduct.fromSnapshot(wp.toSnapshot(), auditLog);
    expect(() => restored.reviseDraft(attorney, "sneaky edit after reload")).toThrow(ReviewGateError);
    restored.release(attorney);
    expect(restored.status).toBe("released");
  });

  it("a rehydrated work product with unresolved flags still blocks approval", () => {
    const auditLog = new AuditLog();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "plea_agreement_memo", content: "x" }, auditLog);
    wp.addFlag("padilla_advisory_required");
    wp.submitForReview(paralegal);

    const restored = WorkProduct.fromSnapshot(wp.toSnapshot(), auditLog);
    expect(() => restored.approve(attorney)).toThrow(ReviewGateError);
  });

  it("WorkProductStore round-trips every registered work product", () => {
    const auditLog = new AuditLog();
    const store = new WorkProductStore();
    store.register(new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "a" }, auditLog));
    store.register(new WorkProduct({ id: "wp2", matterId: "m2", kind: "discovery_request", content: "b" }, auditLog));

    const restored = WorkProductStore.fromSnapshot(store.toSnapshot(), auditLog);
    expect(restored.listAll()).toHaveLength(2);
    expect(restored.get("wp2")?.content).toBe("b");
  });
});

describe("json-file-store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "legal-ai-persist-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the default value when the file doesn't exist yet", async () => {
    const value = await readJsonFile(path.join(dir, "nope.json"), { fallback: true });
    expect(value).toEqual({ fallback: true });
  });

  it("round-trips arbitrary JSON data through a real file, creating parent directories", async () => {
    const filePath = path.join(dir, "nested", "state.json");
    await writeJsonFile(filePath, { a: 1, b: ["x", "y"] });
    const loaded = await readJsonFile(filePath, {});
    expect(loaded).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("overwrites cleanly on a second write (no stale leftover data)", async () => {
    const filePath = path.join(dir, "state.json");
    await writeJsonFile(filePath, { version: 1 });
    await writeJsonFile(filePath, { version: 2 });
    expect(await readJsonFile(filePath, {})).toEqual({ version: 2 });
  });
});

describe("system-state persistence integration", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "legal-ai-system-state-"));
    filePath = path.join(dir, "system-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads an empty state from a fresh file path", async () => {
    const state = await loadSystemState(filePath);
    expect(state.workProductStore.listAll()).toHaveLength(0);
    expect(state.auditLog.count()).toBe(0);
    expect(state.utilization.all()).toHaveLength(0);
  });

  it("persists and reloads a full working state across separate load calls, simulating a process restart", async () => {
    const state = await loadSystemState(filePath);
    const wp = new WorkProduct(
      { id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft" },
      state.auditLog,
    );
    state.workProductStore.register(wp);
    wp.submitForReview(paralegal);
    state.utilization.start({ matterId: "m1", agentRole: "paralegal", taskType: "drafting", description: "x" });

    await saveSystemState(filePath, state);

    // Simulate a fresh process: nothing here shares references with `state` above.
    const reloaded = await loadSystemState(filePath);
    expect(reloaded.workProductStore.get("wp1")?.status).toBe("pending_review");
    expect(reloaded.utilization.all()).toHaveLength(1);
    expect(reloaded.auditLog.count()).toBeGreaterThan(0);

    // And the reloaded work product is still a fully functional, rule-enforcing object.
    reloaded.workProductStore.get("wp1")!.approve(attorney);
    expect(reloaded.workProductStore.get("wp1")!.status).toBe("approved");
  });

  it("persists and reloads scheduled appointments across a process restart", async () => {
    const receptionist: Actor = { id: "r1", role: "receptionist" };
    const state = await loadSystemState(filePath);
    const appt = state.scheduling.scheduleConsultation(receptionist, {
      matterId: "m1",
      startTime: new Date("2026-08-01T15:00:00Z"),
      attorneyId: "a1",
    });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    const reloadedAppt = reloaded.scheduling.get(appt.id);
    expect(reloadedAppt?.status).toBe("scheduled");
    expect(reloadedAppt?.attorneyId).toBe("a1");

    // Reloaded service is still a fully functional object: overlap checking still works.
    expect(() =>
      reloaded.scheduling.scheduleConsultation(receptionist, {
        matterId: "m2",
        startTime: new Date("2026-08-01T15:00:00Z"),
        attorneyId: "a1",
      }),
    ).toThrow(/overlapping/);
  });

  it("persists and reloads paralegal-matter assignments across a process restart", async () => {
    const state = await loadSystemState(filePath);
    state.accessControl.assignParalegal("p1", "m1", { highSensitivityGranted: true });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.accessControl.getParalegalAssignment("p1")).toEqual({
      actorId: "p1",
      matterId: "m1",
      highSensitivityGranted: true,
    });

    // Reloaded instance still enforces the rules.
    expect(() =>
      reloaded.accessControl.authorize({ actor: paralegal, matterId: "m2", category: "case_file" }),
    ).toThrow(/different matter/);
  });

  it("persists and reloads uploaded case documents across a process restart", async () => {
    const state = await loadSystemState(filePath);
    const uploaded = state.documentStore.upload({
      matterId: "m1",
      fileName: "contract.pdf",
      contentType: "application/pdf",
      content: "aGVsbG8=",
      uploadedBy: "p1",
    });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.documentStore.get(uploaded.id)).toEqual(uploaded);
    expect(reloaded.documentStore.listByMatter("m1")).toHaveLength(1);
  });

  it("persists and reloads saved research references across a process restart", async () => {
    const state = await loadSystemState(filePath);
    const saved = state.researchLibrary.save({ matterId: "m1", citation: "410 U.S. 113", title: "Roe v. Wade", savedBy: "p1" });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.researchLibrary.get(saved.id)).toEqual(saved);
    expect(reloaded.researchLibrary.listByMatter("m1")).toHaveLength(1);
  });

  it("persists and reloads messaging conversations/messages across a process restart", async () => {
    const state = await loadSystemState(filePath);
    const conversation = state.messaging.getOrCreateDirectConversation("a1", "p1");
    state.messaging.postMessage(conversation.id, "a1", "hello");

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.messaging.getOrCreateDirectConversation("p1", "a1").id).toBe(conversation.id);
    expect(reloaded.messaging.listMessages(conversation.id).map((m) => m.body)).toEqual(["hello"]);
  });

  it("persists and reloads staff schedule entries across a process restart", async () => {
    const state = await loadSystemState(filePath);
    state.staffSchedule.setEntry("a1", "2026-07-28", "in_office");

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.staffSchedule.listForActor("a1")).toHaveLength(1);
    expect(reloaded.staffSchedule.listForActor("a1")[0]!.status).toBe("in_office");
  });

  it("persists and reloads matter records (the input to conflicts screening) across a restart", async () => {
    const state = await loadSystemState(filePath);
    state.matters.upsert("m-1", {
      title: "State v. Ruiz",
      status: "open",
      parties: [{ name: "Carlos Ruiz", role: "client", note: undefined }],
    });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    const restored = reloaded.matters.get("m-1");
    expect(restored?.title).toBe("State v. Ruiz");
    expect(restored?.parties[0]?.name).toBe("Carlos Ruiz");
  });

  it("persists and reloads the trust ledger, and the reloaded one still refuses an overdraw", async () => {
    const state = await loadSystemState(filePath);
    state.trustLedger.record({
      matterId: "m-1",
      type: "deposit",
      amountCents: 250_00,
      description: "Retainer",
      recordedBy: "a1",
    });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.trustLedger.balanceForMatter("m-1")).toBe(250_00);
    // Rules survive the round-trip, not just the numbers.
    expect(() =>
      reloaded.trustLedger.record({
        matterId: "m-1",
        type: "disbursement",
        amountCents: 250_01,
        description: "Too much",
        recordedBy: "a1",
      }),
    ).toThrow(/overdraw/i);
  });

  it("persists and reloads invoices, payments and the numbering sequence", async () => {
    const state = await loadSystemState(filePath);
    const invoice = state.invoices.createDraft({ matterId: "m-1", issuedBy: "a1" });
    state.invoices.addLineItem(invoice.id, {
      description: "Drafting",
      source: "time",
      quantityMilli: 2_000,
      unitAmountCents: 300_00,
    });
    state.invoices.send(invoice.id);
    state.invoices.recordPayment({ invoiceId: invoice.id, amountCents: 100_00, method: "check", recordedBy: "a1" });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.invoices.totals(invoice.id)).toEqual({
      subtotalCents: 600_00,
      paidCents: 100_00,
      balanceCents: 500_00,
    });
    // A reloaded sent invoice is still locked.
    expect(() =>
      reloaded.invoices.addLineItem(invoice.id, { description: "x", source: "flat", quantityMilli: 1000, unitAmountCents: 1 }),
    ).toThrow(/can't be edited/i);
  });

  it("persists and reloads payroll rates and worked hours", async () => {
    const state = await loadSystemState(filePath);
    state.payroll.setRate({ actorId: "p1", hourlyCents: 32_00, effectiveFrom: "2026-01-01", setBy: "a1" });
    state.payroll.recordHours({ actorId: "p1", date: "2026-07-02", hoursMilli: 7_500, description: "Work", recordedBy: "p1" });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.payroll.summarize("2026-07-01", "2026-07-31").totalGrossPayCents).toBe(240_00);
  });

  it("persists and reloads time-clock shifts, including one still open", async () => {
    const state = await loadSystemState(filePath);
    const closed = state.timeClock.clockIn("p1");
    state.timeClock.clockOut("p1");
    state.timeClock.adjust(closed.id, { clockOutAt: "2030-01-01T17:00:00Z", by: "a1", reason: "forgot" });
    state.timeClock.clockIn("p2");

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.timeClock.get(closed.id)!.corrections).toHaveLength(1);
    expect(reloaded.timeClock.openShift("p1")).toBeUndefined();
    // Someone mid-shift when the process restarted is still mid-shift after it.
    expect(reloaded.timeClock.openShift("p2")).toBeDefined();
    // And the rules survive the reload: no double-punch, no double-post.
    expect(() => reloaded.timeClock.clockIn("p2")).toThrow(/already clocked in/i);
    reloaded.timeClock.markPosted(closed.id, "worked_1");
    expect(() => reloaded.timeClock.markPosted(closed.id, "worked_2")).toThrow(/already been posted/i);
  });

  it("persists and reloads billing hours entries across a process restart", async () => {
    const state = await loadSystemState(filePath);
    const entry = state.billingHours.log({ matterId: "m1", actorId: "p1", date: "2026-07-28", hours: 2, description: "Discovery review" });

    await saveSystemState(filePath, state);

    const reloaded = await loadSystemState(filePath);
    expect(reloaded.billingHours.get(entry.id)).toEqual(entry);
    expect(reloaded.billingHours.listByMatter("m1")).toHaveLength(1);
  });
});
