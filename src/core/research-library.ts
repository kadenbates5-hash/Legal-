/**
 * Central in-memory registry of statute/case-law references a paralegal
 * or attorney has explicitly saved against a matter — the "quick access"
 * half of legal research, as distinct from the search itself
 * (`integrations/courtlistener.ts`) and from `ParalegalDraftingSession`'s
 * `draftResearchSummary()` (a drafted, agent-written summary that becomes
 * reviewable `WorkProduct`). A saved reference is just a bookmark to a
 * real citation — nothing here is agent-generated text, so it never goes
 * through the review-gate; it's a research aid, not something delivered
 * to a client. Saving is always an explicit human action (§7's "manual
 * only" relevance model) — nothing here infers which case matters to
 * which matter on its own.
 */
export interface SavedReference {
  id: string;
  matterId: string;
  /** e.g. "410 U.S. 113" or "18 U.S.C. § 1001" — whatever citation form the source uses. */
  citation: string;
  title: string;
  url: string | undefined;
  note: string | undefined;
  savedBy: string;
  savedAt: string;
}

export class ResearchLibrary {
  #byId = new Map<string, SavedReference>();
  #nextId = 1;

  save(params: { matterId: string; citation: string; title: string; url?: string; note?: string; savedBy: string }): SavedReference {
    const reference: SavedReference = {
      id: `ref_${this.#nextId++}`,
      matterId: params.matterId,
      citation: params.citation,
      title: params.title,
      url: params.url,
      note: params.note,
      savedBy: params.savedBy,
      savedAt: new Date().toISOString(),
    };
    this.#byId.set(reference.id, reference);
    return reference;
  }

  get(id: string): SavedReference | undefined {
    return this.#byId.get(id);
  }

  listAll(): SavedReference[] {
    return [...this.#byId.values()];
  }

  listByMatter(matterId: string): SavedReference[] {
    return this.listAll().filter((ref) => ref.matterId === matterId);
  }

  delete(id: string): void {
    this.#byId.delete(id);
  }

  toSnapshot(): SavedReference[] {
    return this.listAll().map((ref) => ({ ...ref }));
  }

  static fromSnapshot(snapshot: readonly SavedReference[]): ResearchLibrary {
    const library = new ResearchLibrary();
    let maxId = 0;
    for (const ref of snapshot) {
      library.#byId.set(ref.id, { ...ref });
      const num = Number(ref.id.replace(/^ref_/, ""));
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    library.#nextId = maxId + 1;
    return library;
  }
}
