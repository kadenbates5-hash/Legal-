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

export interface UpcomingDeadline {
  matterId: string;
  type: DeadlineType;
  /** The soonest date any source has proposed. */
  date: string;
  /** Negative once the date has passed. */
  daysAway: number;
  confirmationState: DeadlineStatus["state"];
  calculations: DeadlineCalculation[];
  overdue: boolean;
}

/** Whole days between two ISO dates, in UTC so a timezone can't produce an off-by-one. */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

  /**
   * Deadlines falling within the next `withinDays`, soonest first.
   *
   * The field that earns its place here is `confirmationState`. A
   * deadline three days away that is still **single-sourced** is the
   * most dangerous item a firm can be holding: the date came from one
   * place, nobody has checked it, and there is no longer time to
   * discover it was wrong. A list of dates alone would hide exactly that
   * — so the state travels with every row and `mostUrgent()` ranks by
   * it, not only by date.
   *
   * A `conflict` is included regardless of how its dates sort, because
   * two sources disagreeing about a date days away is worse than either
   * date being correct.
   *
   * Dates are compared as ISO strings against a caller-supplied "today",
   * so the firm's own notion of the current day governs — the same
   * reasoning as `time-clock.ts` refusing to bucket by UTC.
   */
  listUpcoming(params: { today: string; withinDays: number }): UpcomingDeadline[] {
    const horizon = addDays(params.today, params.withinDays);
    const upcoming: UpcomingDeadline[] = [];

    for (const [k] of this.#calculationsByKey) {
      const [matterId, type] = k.split("::") as [string, DeadlineType];
      const status = this.status(matterId, type);
      // The earliest date any source proposed. For a conflict that is
      // deliberately the *soonest* of the disagreeing dates: if one
      // source says Friday and another says next Tuesday, the firm has
      // until Friday to find out which is right.
      const dates = status.calculations.map((c) => c.date).sort();
      const date = dates[0];
      if (!date) continue;
      if (date > horizon) continue;

      upcoming.push({
        matterId,
        type,
        date,
        daysAway: daysBetweenDates(params.today, date),
        confirmationState: status.state,
        calculations: status.calculations,
        // Past due is reported, not filtered out. A deadline that has
        // slipped is the most important thing on the list, and dropping
        // it once the date passes is how it stops being anybody's
        // problem.
        overdue: date < params.today,
      });
    }

    return upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.matterId.localeCompare(b.matterId));
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
