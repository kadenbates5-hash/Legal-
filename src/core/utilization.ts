import type { AgentRole } from "./types.js";

/**
 * §4: AI utilization tracking — internal operational telemetry only. Never
 * presented or convertible into a client invoice line; walled off from the
 * billing system entirely (no reference to a billing module exists here).
 * Logging is passive/automatic and needs no attorney sign-off.
 */
export type UtilizationTaskType =
  | "drafting"
  | "research"
  | "intake"
  | "scheduling"
  | "deadline_calc"
  | "document_review"
  | "other";

export type UtilizationStatus = "completed" | "sent_for_review" | "revised_after_review" | "abandoned";

export interface UtilizationEntry {
  readonly id: string;
  readonly matterId: string;
  readonly agentRole: AgentRole;
  readonly taskType: UtilizationTaskType;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly description: string;
  status: UtilizationStatus;
}

export class UtilizationTracker {
  #entries: UtilizationEntry[] = [];
  #nextId = 1;

  start(params: {
    matterId: string;
    agentRole: AgentRole;
    taskType: UtilizationTaskType;
    description: string;
  }): UtilizationEntry {
    const entry: UtilizationEntry = {
      id: `util_${this.#nextId++}`,
      matterId: params.matterId,
      agentRole: params.agentRole,
      taskType: params.taskType,
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      description: params.description,
      status: "sent_for_review",
    };
    this.#entries.push(entry);
    return entry;
  }

  finish(id: string, status: UtilizationStatus): void {
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry) throw new Error(`unknown utilization entry '${id}'`);
    (entry as { endedAt: string }).endedAt = new Date().toISOString();
    entry.status = status;
  }

  /** Time per matter, across all task types. */
  timePerMatter(matterId: string): number {
    return this.#sumDurationsMs(this.#entries.filter((e) => e.matterId === matterId));
  }

  /** Time per task type, firm-wide. */
  timePerTaskType(taskType: UtilizationTaskType): number {
    return this.#sumDurationsMs(this.#entries.filter((e) => e.taskType === taskType));
  }

  /** Agent time vs. human review/correction signal: entries that needed revision after review. */
  revisionRate(agentRole?: AgentRole): number {
    const pool = agentRole ? this.#entries.filter((e) => e.agentRole === agentRole) : this.#entries;
    const finished = pool.filter((e) => e.status !== "sent_for_review");
    if (finished.length === 0) return 0;
    const revised = finished.filter((e) => e.status === "revised_after_review").length;
    return revised / finished.length;
  }

  all(): readonly UtilizationEntry[] {
    return this.#entries;
  }

  #sumDurationsMs(entries: UtilizationEntry[]): number {
    return entries.reduce((total, e) => {
      if (!e.endedAt) return total;
      return total + (Date.parse(e.endedAt) - Date.parse(e.startedAt));
    }, 0);
  }
}
