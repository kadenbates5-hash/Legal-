import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { MatterStore } from "../core/matters.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { DocumentStore } from "../core/document-store.js";
import type { ResearchLibrary } from "../core/research-library.js";
import type { BillingHoursStore } from "../core/billing-hours.js";

/**
 * Search across everything a firm has filed.
 *
 * The need is mundane and constant: *"where's that motion about the
 * traffic stop?"*. Without it a firm with two hundred matters navigates
 * by memory, and the answer to any question is "open matters until you
 * find it".
 *
 * **Access control is the hard part, not the matching.** A search box is
 * the classic way privileged material leaks: it reaches across every
 * store at once, and a naive implementation happily tells a paralegal
 * that a matter they can't open contains the phrase they typed. So every
 * hit goes through the same `AccessControl.authorize()` check as the
 * panel it came from, and a matter the caller can't reach is **silently
 * omitted** — not refused, not counted, not hinted at. The same
 * reasoning as `InvoicingService.listOutstanding()`: an error message
 * saying "3 results hidden" is itself a disclosure.
 *
 * Ranking is deliberately simple — a title match outranks a body match,
 * and an exact phrase outranks scattered words. This is not an
 * information-retrieval system and shouldn't pretend to be; it is a
 * find-the-thing-you-remember tool, and for that, predictable beats
 * clever.
 */
export type SearchHitKind = "matter" | "work_product" | "document" | "research" | "time_entry";

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  matterId: string;
  /** What to show as the result's heading. */
  title: string;
  /** Text around the match, with the matched terms left in place for the UI to mark. */
  snippet: string;
  /** Secondary line: a status, a date, whoever filed it. */
  meta: string;
  score: number;
}

export interface SearchResults {
  query: string;
  hits: SearchHit[];
  /** True when results were cut off by `limit`, so the UI can say so rather than implying completeness. */
  truncated: boolean;
  /**
   * Stated in the UI on every search. Document *contents* are not
   * indexed — only file names — and a firm that assumes otherwise will
   * conclude a document doesn't exist when it simply wasn't looked
   * inside. Being explicit is the difference between a limitation and a
   * trap.
   */
  notSearched: string[];
}

const DEFAULT_LIMIT = 50;
const SNIPPET_RADIUS = 60;

/** Case- and punctuation-insensitive terms; empty when the query is only noise. */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}§.'-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/**
 * Scores `haystack` against the query. `weight` separates a title match
 * from a body match: finding "Ruiz" in a matter caption is a much
 * stronger signal than finding it in the body of a long document.
 */
function scoreText(haystack: string, phrase: string, words: string[], weight: number): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  // The whole phrase is worth far more than its words scattered apart —
  // someone typing "motion to suppress" means that, not every document
  // containing "motion".
  if (phrase.length > 1 && lower.includes(phrase)) score += 10 * weight;
  for (const word of words) {
    if (lower.includes(word)) score += weight;
  }
  return score;
}

/** Text around the first match, so a result is recognisable without opening it. */
function snippetAround(text: string, phrase: string, words: string[]): string {
  const lower = text.toLowerCase();
  let at = phrase.length > 1 ? lower.indexOf(phrase) : -1;
  if (at === -1) {
    for (const word of words) {
      at = lower.indexOf(word);
      if (at !== -1) break;
    }
  }
  if (at === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim();

  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS * 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export class SearchService {
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #matters: MatterStore;
  #workProducts: WorkProductStore;
  #documents: DocumentStore;
  #research: ResearchLibrary;
  #billingHours: BillingHoursStore;

  constructor(params: {
    accessControl: AccessControl;
    auditLog: AuditLog;
    matters: MatterStore;
    workProducts: WorkProductStore;
    documents: DocumentStore;
    research: ResearchLibrary;
    billingHours: BillingHoursStore;
  }) {
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#matters = params.matters;
    this.#workProducts = params.workProducts;
    this.#documents = params.documents;
    this.#research = params.research;
    this.#billingHours = params.billingHours;
  }

  search(actor: Actor, query: string, options: { limit?: number } = {}): SearchResults {
    if (actor.role !== "attorney" && actor.role !== "paralegal") {
      throw new AccessDeniedError(`searching case files is paralegal/attorney-only (got role '${actor.role}')`);
    }
    const phrase = query.trim().toLowerCase();
    const words = terms(query);
    const notSearched = [
      "the contents of uploaded files (only their names) — draft a report from a PDF to make its text searchable",
      "message threads and the audit log",
    ];
    if (words.length === 0) {
      return { query, hits: [], truncated: false, notSearched };
    }

    const limit = options.limit ?? DEFAULT_LIMIT;
    const hits: SearchHit[] = [];
    // Whether a matter is reachable is asked once per matter, not once
    // per record: a search touching 500 documents across 40 matters would
    // otherwise write 500 access-denial entries into the audit log.
    const reachable = new Map<string, boolean>();
    const canSee = (matterId: string, category: "case_file" | "billing_internal"): boolean => {
      const key = `${matterId}:${category}`;
      const cached = reachable.get(key);
      if (cached !== undefined) return cached;
      let allowed = true;
      try {
        this.#accessControl.authorize({ actor, matterId, category });
      } catch {
        allowed = false;
      }
      reachable.set(key, allowed);
      return allowed;
    };

    /* --- matters: the caption and the parties --- */
    for (const matter of this.#matters.listAll()) {
      if (!canSee(matter.matterId, "case_file")) continue;
      const parties = matter.parties.map((p) => p.name).join(", ");
      const body = [matter.description ?? "", parties].join(" ");
      const score =
        scoreText(matter.title, phrase, words, 4) +
        scoreText(matter.matterId, phrase, words, 3) +
        scoreText(body, phrase, words, 1);
      if (score === 0) continue;
      hits.push({
        kind: "matter",
        id: matter.matterId,
        matterId: matter.matterId,
        title: matter.title,
        snippet: parties ? `Parties: ${parties}` : matter.description ?? "",
        meta: `${matter.status} · opened ${matter.openedAt.slice(0, 10)}`,
        score,
      });
    }

    /* --- work product: the drafted text itself --- */
    for (const wp of this.#workProducts.listAll()) {
      if (!canSee(wp.matterId, "case_file")) continue;
      const snapshot = wp.toSnapshot();
      const score = scoreText(wp.kind, phrase, words, 3) + scoreText(snapshot.content, phrase, words, 1);
      if (score === 0) continue;
      hits.push({
        kind: "work_product",
        id: wp.id,
        matterId: wp.matterId,
        title: `${wp.kind.replace(/_/g, " ")} — ${this.#matterLabel(wp.matterId)}`,
        snippet: snippetAround(snapshot.content, phrase, words),
        meta: `${wp.status.replace(/_/g, " ")}${snapshot.flags.length ? ` · ${snapshot.flags.length} flag(s)` : ""}`,
        score,
      });
    }

    /* --- documents: file names only, see `notSearched` --- */
    for (const doc of this.#documents.listAll()) {
      if (!canSee(doc.matterId, "case_file")) continue;
      const score = scoreText(doc.fileName, phrase, words, 4);
      if (score === 0) continue;
      hits.push({
        kind: "document",
        id: doc.id,
        matterId: doc.matterId,
        title: doc.fileName,
        snippet: this.#matterLabel(doc.matterId),
        meta: `${(doc.size / 1024).toFixed(0)} KB · uploaded ${doc.uploadedAt.slice(0, 10)} by ${doc.uploadedBy}`,
        score,
      });
    }

    /* --- saved research --- */
    for (const ref of this.#research.listAll()) {
      if (!canSee(ref.matterId, "case_file")) continue;
      const score =
        scoreText(ref.title, phrase, words, 4) +
        scoreText(ref.citation, phrase, words, 4) +
        scoreText(ref.note ?? "", phrase, words, 1);
      if (score === 0) continue;
      hits.push({
        kind: "research",
        id: ref.id,
        matterId: ref.matterId,
        title: ref.title,
        snippet: ref.note ?? ref.citation,
        meta: `${ref.citation} · saved ${ref.savedAt.slice(0, 10)}`,
        score,
      });
    }

    /* --- logged time: often where the description of what happened lives --- */
    for (const entry of this.#billingHours.listAll()) {
      if (!canSee(entry.matterId, "billing_internal")) continue;
      const score = scoreText(entry.description, phrase, words, 2);
      if (score === 0) continue;
      hits.push({
        kind: "time_entry",
        id: entry.id,
        matterId: entry.matterId,
        title: entry.description,
        snippet: this.#matterLabel(entry.matterId),
        meta: `${entry.hours}h on ${entry.date} · ${entry.actorId}`,
        score,
      });
    }

    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const truncated = hits.length > limit;

    // Searching is logged. A search reaches across every matter the
    // caller can see at once, which makes it exactly the sort of access
    // an attorney reviewing an incident wants a record of — and the
    // query itself is the interesting part.
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "search_run",
      detail: `query=${query.slice(0, 200)} hits=${hits.length}`,
    });

    return { query, hits: hits.slice(0, limit), truncated, notSearched };
  }

  #matterLabel(matterId: string): string {
    return this.#matters.get(matterId)?.title ?? matterId;
  }
}
