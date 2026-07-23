import { AuditLog, type AuditEntry } from "../core/audit.js";
import { UtilizationTracker, type UtilizationSnapshot } from "../core/utilization.js";
import { WorkProductStore } from "../core/work-product-store.js";
import type { WorkProductSnapshot } from "../core/review-gate.js";
import { readJsonFile, writeJsonFile } from "./json-file-store.js";

/**
 * Bundles the three stateful core stores (audit log, utilization tracker,
 * work-product store) into one persisted JSON document. This is the
 * concrete stopgap for §8's "not yet built — persistence": file-backed
 * rather than in-memory-only, but still a single-process, single-file
 * store — not a substitute for a real multi-user database before this
 * goes anywhere near real clients.
 */
export interface SystemStateSnapshot {
  version: 1;
  auditLog: AuditEntry[];
  utilization: UtilizationSnapshot;
  workProducts: WorkProductSnapshot[];
}

export interface SystemState {
  auditLog: AuditLog;
  utilization: UtilizationTracker;
  workProductStore: WorkProductStore;
}

function emptySnapshot(): SystemStateSnapshot {
  return { version: 1, auditLog: [], utilization: { entries: [], nextId: 1 }, workProducts: [] };
}

export async function loadSystemState(filePath: string): Promise<SystemState> {
  const snapshot = await readJsonFile<SystemStateSnapshot>(filePath, emptySnapshot());
  const auditLog = AuditLog.fromSnapshot(snapshot.auditLog);
  const utilization = UtilizationTracker.fromSnapshot(snapshot.utilization);
  const workProductStore = WorkProductStore.fromSnapshot(snapshot.workProducts, auditLog);
  return { auditLog, utilization, workProductStore };
}

export async function saveSystemState(filePath: string, state: SystemState): Promise<void> {
  const snapshot: SystemStateSnapshot = {
    version: 1,
    auditLog: state.auditLog.toSnapshot(),
    utilization: state.utilization.toSnapshot(),
    workProducts: state.workProductStore.toSnapshot(),
  };
  await writeJsonFile(filePath, snapshot);
}
