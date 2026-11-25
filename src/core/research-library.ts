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

/**
 * A saved reference is a bookmark, so its fields are a bookmark's size.
 * They had no limit at all, and each one is stored in the state document
 * and listed on the Research panel and in the client file export.
 */
function boundedText(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label} can be at most ${max.toLocaleString("en-US")} characters`);
  return trimmed;
}

/**
 * A reference's link is opened from the panel, so only a web address is
 * kept. The panel already refuses to render anything else as a link, but
 * the record is also handed out in the client file export, which has no
 * such filter.
 */
function checkedUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 2_000) throw new Error("a link can be at most 2,000 characters");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("a link must be a full web address, starting with https://");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("a link must be a web address (http or https)");
  }
  return trimmed;
}

export class ResearchLibrary {
  #byId = new Map<string, SavedReference>();
  #nextId = 1;

  save(params: { matterId: string; citation: string; title: string; url?: string; note?: string; savedBy: string }): SavedReference {
    const reference: SavedReference = {
      id: `ref_${this.#nextId++}`,
      matterId: params.matterId,
      // Room for every parallel citation a much-reported case carries —
      // "Save to matter" joins them all.
      citation: boundedText(params.citation, 1_000, "a citation"),
      title: boundedText(params.title, 1_000, "a title"),
      url: checkedUrl(params.url),
      note: params.note?.trim() ? boundedText(params.note, 5_000, "a note") : undefined,
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
