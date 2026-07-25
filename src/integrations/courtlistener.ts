/**
 * CourtListener (courtlistener.com, run by the nonprofit Free Law
 * Project) — the real case-law search vendor behind Docket's Research
 * panel. Chosen because it's a genuine public case-law database with a
 * free REST API, not a paid Westlaw/Lexis-style product this project
 * can't provision credentials for. Case law is public record, so there's
 * no §5-style confidentiality/subpoena due-diligence question the way
 * there is for STT/TTS or calendar vendors — the only real caveat is
 * accuracy: this is a search result, not a verified citation, and the
 * Research panel says so.
 *
 * `search()`'s query/response handling is written against CourtListener's
 * documented v4 search API from training knowledge — this sandbox's
 * network policy blocked reaching `courtlistener.com` directly while
 * building this (same constraint noted for `docs.voicebox.sh`), so the
 * exact response field names are best-effort. `parseSearchResult()` is
 * exported specifically so that parsing is unit-testable and easy to
 * correct against a real response without touching the request/auth
 * plumbing around it.
 */
export interface CaseSearchResult {
  caseName: string;
  /** e.g. ["410 U.S. 113"] — a case can have more than one reporter citation. */
  citations: string[];
  court: string | undefined;
  /** YYYY-MM-DD, if the source provides it. */
  dateFiled: string | undefined;
  snippet: string | undefined;
  url: string;
}

export interface CaseLawSearchClient {
  search(query: string): Promise<CaseSearchResult[]>;
}

interface CourtListenerApiResult {
  caseName?: string;
  citation?: string[];
  court?: string;
  dateFiled?: string;
  snippet?: string;
  absolute_url?: string;
}

const DEFAULT_BASE_URL = "https://www.courtlistener.com/api/rest/v4";
const SITE_ORIGIN = "https://www.courtlistener.com";

/** Exported for testing without a live CourtListener instance — the parsing/defaulting rules are the part worth unit-testing. */
export function parseSearchResult(item: CourtListenerApiResult): CaseSearchResult | undefined {
  if (!item.caseName || !item.absolute_url) return undefined;
  return {
    caseName: item.caseName,
    citations: item.citation ?? [],
    court: item.court,
    dateFiled: item.dateFiled,
    snippet: item.snippet,
    url: item.absolute_url.startsWith("http") ? item.absolute_url : `${SITE_ORIGIN}${item.absolute_url}`,
  };
}

export class CourtListenerClient implements CaseLawSearchClient {
  #baseUrl: string;
  #apiToken: string | undefined;

  constructor(params?: { baseUrl?: string; apiToken?: string }) {
    this.#baseUrl = (params?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#apiToken = params?.apiToken;
  }

  async search(query: string): Promise<CaseSearchResult[]> {
    const url = new URL(`${this.#baseUrl}/search/`);
    url.searchParams.set("q", query);
    url.searchParams.set("type", "o"); // opinions (case law) — not statutes, RECAP dockets, etc.

    const res = await fetch(url, {
      headers: this.#apiToken ? { Authorization: `Token ${this.#apiToken}` } : {},
    });
    if (!res.ok) {
      throw new Error(`CourtListener search failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { results?: CourtListenerApiResult[] };
    const results: CaseSearchResult[] = [];
    for (const item of body.results ?? []) {
      const parsed = parseSearchResult(item);
      if (parsed) results.push(parsed);
    }
    return results;
  }
}
