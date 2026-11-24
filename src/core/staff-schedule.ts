import { isCalendarDate } from "./calendar-date.js";

/**
 * The staff work schedule: when each person on the team is in the office,
 * working remotely, or out — one entry per (actor, date). Deliberately
 * separate from `core/scheduling.ts`'s `SchedulingService`, which books
 * client consultations with an attorney; this tracks the staff's own
 * whereabouts, not client-facing appointments.
 */
export type StaffScheduleStatus = "in_office" | "remote" | "out";

export interface StaffScheduleEntry {
  id: string;
  actorId: string;
  /** ISO calendar date, e.g. "2026-07-28" — one entry per actor per date. */
  date: string;
  status: StaffScheduleStatus;
  note: string | undefined;
  updatedAt: string;
}

const STATUSES: readonly string[] = ["in_office", "remote", "out"];

export class StaffScheduleStore {
  #byId = new Map<string, StaffScheduleEntry>();
  #idByActorAndDate = new Map<string, string>();
  #nextId = 1;

  #key(actorId: string, date: string): string {
    return `${actorId}::${date}`;
  }

  /** Upserts the single entry for this actor/date pair. */
  setEntry(actorId: string, date: string, status: StaffScheduleStatus, note?: string): StaffScheduleEntry {
    // Both used to be stored as sent: a day of "garbage" that no date view
    // ever finds, and a status of "office" that the panel can't show as in,
    // remote or out.
    if (!STATUSES.includes(status)) {
      throw new Error(`status must be in_office, remote or out (got '${String(status)}')`);
    }
    if (!isCalendarDate(date)) throw new Error(`date must be a date in YYYY-MM-DD form (got '${date}')`);
    const key = this.#key(actorId, date);
    const existingId = this.#idByActorAndDate.get(key);
    const entry: StaffScheduleEntry = {
      id: existingId ?? `sched_${this.#nextId++}`,
      actorId,
      date,
      status,
      note,
      updatedAt: new Date().toISOString(),
    };
    this.#byId.set(entry.id, entry);
    this.#idByActorAndDate.set(key, entry.id);
    return entry;
  }

  removeEntry(actorId: string, date: string): void {
    const key = this.#key(actorId, date);
    const existingId = this.#idByActorAndDate.get(key);
    if (existingId) {
      this.#byId.delete(existingId);
      this.#idByActorAndDate.delete(key);
    }
  }

  listForActor(actorId: string): StaffScheduleEntry[] {
    return [...this.#byId.values()].filter((e) => e.actorId === actorId).sort((a, b) => a.date.localeCompare(b.date));
  }

  listForDate(date: string): StaffScheduleEntry[] {
    return [...this.#byId.values()].filter((e) => e.date === date);
  }

  toSnapshot(): StaffScheduleEntry[] {
    return [...this.#byId.values()].map((e) => ({ ...e }));
  }

  static fromSnapshot(snapshot: readonly StaffScheduleEntry[]): StaffScheduleStore {
    const store = new StaffScheduleStore();
    let maxId = 0;
    for (const entry of snapshot) {
      const copy = { ...entry };
      store.#byId.set(copy.id, copy);
      store.#idByActorAndDate.set(store.#key(copy.actorId, copy.date), copy.id);
      const num = Number(copy.id.replace(/^sched_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    store.#nextId = maxId + 1;
    return store;
  }
}
