import { AuditLog, type AuditEntry } from "../core/audit.js";
import { UtilizationTracker, type UtilizationSnapshot } from "../core/utilization.js";
import { WorkProductStore } from "../core/work-product-store.js";
import type { WorkProductSnapshot } from "../core/review-gate.js";
import { DeadlineTracker, type DeadlineCalculation } from "../core/deadline.js";
import { readJsonFile, writeJsonFile } from "./json-file-store.js";

/**
 * Bundles the stateful core stores (audit log, utilization tracker,
 * work-product store, deadline tracker) into one persisted JSON document.
 * This is the concrete stopgap for §8's "not yet built — persistence":
 * file-backed rather than in-memory-only, but still a single-process,
 * single-file store — not a substitute for a real multi-user database
 * before this goes anywhere near real clients.
 */
export interface SystemStateSnapshot {
  version: 1;
  auditLog: AuditEntry[];
  utilization: UtilizationSnapshot;
  workProducts: WorkProductSnapshot[];
  /** Optional so state files saved before the deadline tracker existed still load. */
  deadlines?: DeadlineCalculation[];
}

export interface SystemState {
  auditLog: AuditLog;
  utilization: UtilizationTracker;
  workProductStore: WorkProductStore;
  deadlineTracker: DeadlineTracker;
}

function emptySnapshot(): SystemStateSnapshot {
  return { version: 1, auditLog: [], utilization: { entries: [], nextId: 1 }, workProducts: [], deadlines: [] };
}

export async function loadSystemState(filePath: string): Promise<SystemState> {
  const snapshot = await readJsonFile<SystemStateSnapshot>(filePath, emptySnapshot());
  const auditLog = AuditLog.fromSnapshot(snapshot.auditLog);
  const utilization = UtilizationTracker.fromSnapshot(snapshot.utilization);
  const workProductStore = WorkProductStore.fromSnapshot(snapshot.workProducts, auditLog);
  const deadlineTracker = DeadlineTracker.fromSnapshot(snapshot.deadlines ?? []);
  return { auditLog, utilization, workProductStore, deadlineTracker };
}

export async function saveSystemState(filePath: string, state: SystemState): Promise<void> {
  const snapshot: SystemStateSnapshot = {
    version: 1,
    auditLog: state.auditLog.toSnapshot(),
    utilization: state.utilization.toSnapshot(),
    workProducts: state.workProductStore.toSnapshot(),
    deadlines: state.deadlineTracker.toSnapshot(),
  };
  await writeJsonFile(filePath, snapshot);
}
