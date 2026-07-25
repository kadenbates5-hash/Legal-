import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import { ResearchLibrary, type SavedReference } from "../core/research-library.js";
import type { CaseLawSearchClient, CaseSearchResult } from "../integrations/courtlistener.js";

/**
 * Backs Docket's "Research" panel: general case-law search (not matter-
 * scoped — case law is public, so there's nothing to authorize per
 * matter for the search itself) plus a matter-scoped "quick access"
 * library of references someone explicitly saved. Same shape as
 * `DocumentsService`: every matter-scoped method authorizes via
 * `AccessControl` before touching the store, since a saved reference is
 * exposed over HTTP by matter id/reference id that any authenticated
 * caller could otherwise name arbitrarily.
 */
function requireResearchRole(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`research is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

export class ResearchService {
  #accessControl: AccessControl;
  #library: ResearchLibrary;
  #searchClient: CaseLawSearchClient;

  constructor(params: { accessControl: AccessControl; library: ResearchLibrary; searchClient: CaseLawSearchClient }) {
    this.#accessControl = params.accessControl;
    this.#library = params.library;
    this.#searchClient = params.searchClient;
  }

  async search(actor: Actor, query: string): Promise<CaseSearchResult[]> {
    requireResearchRole(actor);
    if (!query.trim()) throw new Error("query is required");
    return this.#searchClient.search(query);
  }

  listMatterReferences(actor: Actor, matterId: string): SavedReference[] {
    requireResearchRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    return this.#library.listByMatter(matterId);
  }

  saveReference(
    actor: Actor,
    matterId: string,
    params: { citation: string; title: string; url?: string; note?: string },
  ): SavedReference {
    requireResearchRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    if (!params.citation.trim()) throw new Error("citation is required");
    if (!params.title.trim()) throw new Error("title is required");
    return this.#library.save({ matterId, savedBy: actor.id, ...params });
  }

  deleteReference(actor: Actor, matterId: string, id: string): void {
    requireResearchRole(actor);
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });
    const ref = this.#requireMatterReference(matterId, id);
    this.#library.delete(ref.id);
  }

  #requireMatterReference(matterId: string, id: string): SavedReference {
    const ref = this.#library.get(id);
    if (!ref || ref.matterId !== matterId) {
      throw new Error(`no saved reference '${id}' on matter '${matterId}'`);
    }
    return ref;
  }
}
