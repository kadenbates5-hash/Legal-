/**
 * §3/§7 open item #1: "Deadline calculations are never single-sourced.
 * Speedy trial, arraignment, and bail-hearing deadlines are the top
 * malpractice risk in criminal defense — agent-calculated dates require
 * redundant human/calendar-system verification."
 *
 * This is the enforced redundancy mechanism: a deadline is never treated
 * as trustworthy from a single source. It becomes "confirmed" only once
 * two *independent* sources report the same date for the same matter and
 * deadline type. If two sources disagree, that's a conflict — surfaced
 * immediately, never silently resolved by picking one.
 */
/** The flag a WorkProduct carries when it references an agent-calculated deadline. */
export const DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG = "deadline_requires_redundant_verification";

export type DeadlineType =
  | "speedy_trial"
  | "arraignment"
  | "bail_hearing"
  | "discovery_response"
  | "other";

export type DeadlineSource = "agent" | "human" | "calendar_system";

export interface DeadlineCalculation {
  readonly matterId: string;
  readonly type: DeadlineType;
  readonly date: string;
  readonly source: DeadlineSource;
  readonly recordedAt: string;
  readonly note: string | undefined;
}

export interface DeadlineConflict {
  matterId: string;
  type: DeadlineType;
  calculations: DeadlineCalculation[];
}

export type DeadlineStatus =
  | { state: "unconfirmed"; calculations: DeadlineCalculation[] }
  | { state: "confirmed"; date: string; calculations: DeadlineCalculation[] }
  | { state: "conflict"; calculations: DeadlineCalculation[] };

function key(matterId: string, type: DeadlineType): string {
  return `${matterId}::${type}`;
}

export class DeadlineTracker {
  #calculationsByKey = new Map<string, DeadlineCalculation[]>();

  /**
   * Records a deadline calculation from one source. An `"agent"`
   * calculation alone never confirms anything — it takes a second,
   * independently-sourced calculation (human or calendar_system) agreeing
   * on the same date to reach `"confirmed"`.
   */
  record(params: { matterId: string; type: DeadlineType; date: string; source: DeadlineSource; note?: string }): DeadlineStatus {
    const k = key(params.matterId, params.type);
    const existing = this.#calculationsByKey.get(k) ?? [];
    const calculation: DeadlineCalculation = {
      matterId: params.matterId,
      type: params.type,
      date: params.date,
      source: params.source,
      recordedAt: new Date().toISOString(),
      note: params.note,
    };
    const updated = [...existing, calculation];
    this.#calculationsByKey.set(k, updated);
    return this.status(params.matterId, params.type);
  }

  status(matterId: string, type: DeadlineType): DeadlineStatus {
    const calculations = this.#calculationsByKey.get(key(matterId, type)) ?? [];
    if (calculations.length === 0) return { state: "unconfirmed", calculations };

    const distinctSources = new Set(calculations.map((c) => c.source));
    const distinctDates = new Set(calculations.map((c) => c.date));

    if (distinctSources.size < 2) {
      // Only ever seen from one source (however many times) — still single-sourced.
      return { state: "unconfirmed", calculations };
    }

    if (distinctDates.size > 1) {
      return { state: "conflict", calculations };
    }

    return { state: "confirmed", date: calculations[0]!.date, calculations };
  }

  isConfirmed(matterId: string, type: DeadlineType): boolean {
    return this.status(matterId, type).state === "confirmed";
  }

  /** Every matter/type pair currently in a conflicting state — for a dashboard to surface immediately. */
  listConflicts(): DeadlineConflict[] {
    const conflicts: DeadlineConflict[] = [];
    for (const [k, calculations] of this.#calculationsByKey) {
      const [matterId, type] = k.split("::") as [string, DeadlineType];
      const status = this.status(matterId, type);
      if (status.state === "conflict") {
        conflicts.push({ matterId, type, calculations });
      }
    }
    return conflicts;
  }

  toSnapshot(): DeadlineCalculation[] {
    return [...this.#calculationsByKey.values()].flat();
  }

  static fromSnapshot(calculations: readonly DeadlineCalculation[]): DeadlineTracker {
    const tracker = new DeadlineTracker();
    for (const c of calculations) {
      const k = key(c.matterId, c.type);
      const existing = tracker.#calculationsByKey.get(k) ?? [];
      tracker.#calculationsByKey.set(k, [...existing, { ...c }]);
    }
    return tracker;
  }
}
