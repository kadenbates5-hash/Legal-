/**
 * Real matter records.
 *
 * Until now a "matter" was just a `matterId` string that
 * `WorkProductStore`, `DocumentStore`, `BillingHoursStore` and
 * `AccessControl` all happened to key on. That's enough to file things
 * under, but it can't answer the questions a firm is actually obliged to
 * answer: *who is the client*, *who is on the other side*, and *is this
 * matter still open*. Without those, firm-wide conflict-of-interest
 * screening (see `conflicts.ts`) is impossible — which is why this
 * exists.
 *
 * Deliberately keyed on the same `matterId` string rather than
 * introducing a new primary key, so every existing store keeps working
 * untouched and a matter can still be referenced before its record is
 * filled in. A record here is *descriptive*; it is not an access-control
 * boundary. `AccessControl` remains the only thing that decides who can
 * see what.
 */
export type MatterStatus = "prospective" | "open" | "closed";

/**
 * Which side of a matter a person or organization sits on. This drives
 * conflict severity, not just labelling: adversity is what makes a
 * conflict a conflict.
 */
export type PartyRole = "client" | "adverse" | "related";

export interface MatterParty {
  name: string;
  role: PartyRole;
  /** Free text — "co-defendant", "opposing counsel", "witness", "parent company". */
  note: string | undefined;
}

export interface Matter {
  matterId: string;
  /** Human-facing caption, e.g. "State v. Ruiz". */
  title: string;
  status: MatterStatus;
  practiceAreaId: string | undefined;
  responsibleAttorneyId: string | undefined;
  description: string | undefined;
  parties: MatterParty[];
  openedAt: string;
  closedAt: string | undefined;
  updatedAt: string;
}

export interface MatterInput {
  title?: string;
  status?: MatterStatus;
  practiceAreaId?: string;
  responsibleAttorneyId?: string;
  description?: string;
  parties?: MatterParty[];
}

export class MatterStore {
  #byId = new Map<string, Matter>();

  /**
   * Creates or updates the record for a matter id. Upsert rather than
   * separate create/update because a matter id can already be in use by
   * work product or documents long before anyone fills in who the client
   * is — the record catches up with reality, it doesn't gate it.
   */
  upsert(matterId: string, input: MatterInput): Matter {
    const id = matterId.trim();
    if (!id) throw new Error("matterId is required");
    const now = new Date().toISOString();
    const existing = this.#byId.get(id);
    const status = input.status ?? existing?.status ?? "open";
    const record: Matter = {
      matterId: id,
      title: input.title ?? existing?.title ?? id,
      status,
      practiceAreaId: input.practiceAreaId ?? existing?.practiceAreaId,
      responsibleAttorneyId: input.responsibleAttorneyId ?? existing?.responsibleAttorneyId,
      description: input.description ?? existing?.description,
      parties: (input.parties ?? existing?.parties ?? []).map((p) => ({ ...p })),
      openedAt: existing?.openedAt ?? now,
      // Closing stamps a date; reopening clears it, so "closed" and
      // "closedAt" can never disagree.
      closedAt: status === "closed" ? existing?.closedAt ?? now : undefined,
      updatedAt: now,
    };
    this.#byId.set(id, record);
    return record;
  }

  get(matterId: string): Matter | undefined {
    return this.#byId.get(matterId);
  }

  listAll(): Matter[] {
    return [...this.#byId.values()];
  }

  listByStatus(status: MatterStatus): Matter[] {
    return this.listAll().filter((m) => m.status === status);
  }

  delete(matterId: string): void {
    this.#byId.delete(matterId);
  }

  toSnapshot(): Matter[] {
    return this.listAll().map((m) => ({ ...m, parties: m.parties.map((p) => ({ ...p })) }));
  }

  static fromSnapshot(snapshot: readonly Matter[]): MatterStore {
    const store = new MatterStore();
    for (const m of snapshot) {
      store.#byId.set(m.matterId, { ...m, parties: (m.parties ?? []).map((p) => ({ ...p })) });
    }
    return store;
  }
}
