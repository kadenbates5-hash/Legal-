/**
 * Billable-hours entries logged by an attorney or paralegal against a
 * matter — distinct from `core/utilization.ts`'s `UtilizationTracker`,
 * which is internal AI-utilization telemetry never exposed to a client,
 * not human billable time. This is the human timekeeping record that
 * would actually feed a client invoice (though generating an invoice
 * itself is out of scope here, same as email/SMS reminder-sending in
 * `scheduling.ts`).
 */
export interface BillingHoursEntry {
  id: string;
  matterId: string;
  actorId: string;
  /** ISO calendar date the work was performed, e.g. "2026-07-28". */
  date: string;
  hours: number;
  description: string;
  loggedAt: string;
}

export class BillingHoursStore {
  #byId = new Map<string, BillingHoursEntry>();
  #nextId = 1;

  log(params: { matterId: string; actorId: string; date: string; hours: number; description: string }): BillingHoursEntry {
    if (!Number.isFinite(params.hours) || params.hours <= 0) {
      throw new Error("hours must be a positive number");
    }
    if (!params.description.trim()) {
      throw new Error("description is required");
    }
    const entry: BillingHoursEntry = {
      id: `hrs_${this.#nextId++}`,
      matterId: params.matterId,
      actorId: params.actorId,
      date: params.date,
      hours: params.hours,
      description: params.description.trim(),
      loggedAt: new Date().toISOString(),
    };
    this.#byId.set(entry.id, entry);
    return entry;
  }

  get(id: string): BillingHoursEntry | undefined {
    return this.#byId.get(id);
  }

  /** Every entry, unscoped — callers are responsible for access control (see `SearchService`). */
  listAll(): BillingHoursEntry[] {
    return [...this.#byId.values()].map((e) => ({ ...e }));
  }

  listByMatter(matterId: string): BillingHoursEntry[] {
    return [...this.#byId.values()].filter((e) => e.matterId === matterId);
  }

  listByActor(actorId: string): BillingHoursEntry[] {
    return [...this.#byId.values()].filter((e) => e.actorId === actorId);
  }

  delete(id: string): void {
    this.#byId.delete(id);
  }

  toSnapshot(): BillingHoursEntry[] {
    return [...this.#byId.values()].map((e) => ({ ...e }));
  }

  static fromSnapshot(snapshot: readonly BillingHoursEntry[]): BillingHoursStore {
    const store = new BillingHoursStore();
    let maxId = 0;
    for (const entry of snapshot) {
      store.#byId.set(entry.id, { ...entry });
      const num = Number(entry.id.replace(/^hrs_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    store.#nextId = maxId + 1;
    return store;
  }
}
