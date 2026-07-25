import { AuditLog, type AuditEntry } from "../core/audit.js";
import { UtilizationTracker, type UtilizationSnapshot } from "../core/utilization.js";
import { WorkProductStore } from "../core/work-product-store.js";
import type { WorkProductSnapshot } from "../core/review-gate.js";
import { DeadlineTracker, type DeadlineCalculation } from "../core/deadline.js";
import { SchedulingService, type Appointment } from "../core/scheduling.js";
import { AuthService, type AuthSnapshot } from "../core/auth.js";
import type { AccessControl } from "../core/access-control.js";
import type { FirmConfig } from "../config/firm-config.js";
import { readJsonFile, writeJsonFile } from "./json-file-store.js";

/**
 * Bundles the stateful core stores (audit log, utilization tracker,
 * work-product store, deadline tracker, scheduling service) into one
 * persisted JSON document. This is the concrete stopgap for §8's "not yet
 * built — persistence": file-backed rather than in-memory-only, but still
 * a single-process, single-file store — not a substitute for a real
 * multi-user database before this goes anywhere near real clients.
 */
export interface SystemStateSnapshot {
  version: 1;
  auditLog: AuditEntry[];
  utilization: UtilizationSnapshot;
  workProducts: WorkProductSnapshot[];
  /** Optional so state files saved before these fields existed still load. */
  deadlines?: DeadlineCalculation[];
  appointments?: Appointment[];
  /** User accounts, sessions ("remember me" survives a restart), and the calendar-integration system key. */
  auth?: AuthSnapshot;
}

export interface SystemState {
  auditLog: AuditLog;
  utilization: UtilizationTracker;
  workProductStore: WorkProductStore;
  deadlineTracker: DeadlineTracker;
  scheduling: SchedulingService;
  auth: AuthService;
}

export interface LoadSystemStateOptions {
  firmConfig?: FirmConfig;
  accessControl?: AccessControl;
}

function emptySnapshot(): SystemStateSnapshot {
  return {
    version: 1,
    auditLog: [],
    utilization: { entries: [], nextId: 1 },
    workProducts: [],
    deadlines: [],
    appointments: [],
    auth: { users: [], sessions: [] },
  };
}

export async function loadSystemState(filePath: string, options?: LoadSystemStateOptions): Promise<SystemState> {
  const snapshot = await readJsonFile<SystemStateSnapshot>(filePath, emptySnapshot());
  const auditLog = AuditLog.fromSnapshot(snapshot.auditLog);
  const utilization = UtilizationTracker.fromSnapshot(snapshot.utilization);
  const workProductStore = WorkProductStore.fromSnapshot(snapshot.workProducts, auditLog);
  const deadlineTracker = DeadlineTracker.fromSnapshot(snapshot.deadlines ?? []);
  const scheduling = SchedulingService.fromSnapshot(snapshot.appointments ?? [], options);
  const auth = AuthService.fromSnapshot(snapshot.auth ?? { users: [], sessions: [] });
  return { auditLog, utilization, workProductStore, deadlineTracker, scheduling, auth };
}

export async function saveSystemState(filePath: string, state: SystemState): Promise<void> {
  const snapshot: SystemStateSnapshot = {
    version: 1,
    auditLog: state.auditLog.toSnapshot(),
    utilization: state.utilization.toSnapshot(),
    workProducts: state.workProductStore.toSnapshot(),
    deadlines: state.deadlineTracker.toSnapshot(),
    appointments: state.scheduling.toSnapshot(),
    auth: state.auth.toSnapshot(),
  };
  await writeJsonFile(filePath, snapshot);
}
