import type { Matter, MatterParty, MatterStore, PartyRole } from "./matters.js";

/**
 * Firm-wide conflict-of-interest screening.
 *
 * Running a conflicts check before taking on a matter isn't a nicety —
 * it's an ethical obligation (ABA Model Rules 1.7 on current-client
 * conflicts, 1.9 on former-client conflicts, and 1.10, which imputes one
 * lawyer's conflict to the whole firm). That last rule is why this
 * searches every matter in the firm rather than only the matters the
 * person running the check happens to work on.
 *
 * **This engine deliberately over-matches.** A false positive costs an
 * attorney a minute of reading; a false negative is a rule violation and
 * potentially a disqualification. So name matching is generous and every
 * hit is reported with *why* it matched and how strongly, for a human to
 * triage. Nothing here auto-clears anything — same philosophy as the
 * review gate and as `receptionist/signal-extraction.ts`, where
 * over-escalating is the safe failure mode.
 *
 * What this is not: a judgement about whether a conflict is waivable, or
 * a substitute for an attorney's analysis. It finds candidate matches in
 * the firm's own records. It knows nothing about matters the firm never
 * wrote down.
 */
export type MatchStrength = "exact" | "strong" | "possible";

/**
 * How seriously to treat a hit. `direct` means the search name appears
 * adverse to a client the firm currently represents (or is represented
 * by the firm while adverse to the new party) — the Rule 1.7 case that
 * normally bars the engagement outright. `former_client` is the Rule 1.9
 * case, which turns on whether the matters are substantially related and
 * needs an attorney's judgement. `same_side` is usually benign (the
 * person is already a client) but still surfaced, because "already a
 * client" can also mean a joint-representation problem.
 */
export type ConflictSeverity = "direct" | "former_client" | "same_side" | "informational";

export interface ConflictHit {
  searchedName: string;
  matterId: string;
  matterTitle: string;
  matterStatus: Matter["status"];
  matchedParty: MatterParty;
  matchedName: string;
  matchStrength: MatchStrength;
  severity: ConflictSeverity;
  /** Plain-language reason, written to be read by an attorney triaging a list. */
  explanation: string;
}

export interface ConflictCheckRequest {
  /** Names to screen — typically the prospective client plus every known adverse party. */
  names: readonly string[];
  /** Optional: the side each name would take in the new matter. Adversity is what makes a conflict. */
  roleByName?: Readonly<Record<string, PartyRole>>;
  /** Excluded from results — used when re-screening a matter against everything *else*. */
  excludeMatterId?: string;
}

export interface ConflictCheckResult {
  hits: ConflictHit[];
  /** True when any hit needs attorney attention before proceeding. */
  requiresAttorneyReview: boolean;
  checkedAt: string;
}

/** Honorifics and generational/professional suffixes carry no identity. */
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "hon", "sir", "madam"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "esq", "esquire", "phd", "md", "cpa"]);
/** Entity-type markers: "Acme Corp" and "Acme, Inc." are the same adversary. */
const ENTITY_SUFFIXES = new Set([
  "inc", "llc", "llp", "lp", "ltd", "plc", "corp", "corporation", "co", "company",
  "incorporated", "limited", "pllc", "pc", "na", "sa", "gmbh", "ag", "bv", "nv",
]);

/**
 * Reduces a name to comparable tokens. Handles the shapes that actually
 * show up in intake: "SMITH, John Q." vs "john smith", "Acme, Inc." vs
 * "ACME Corporation", accented spellings, stray punctuation.
 */
export function normalizeName(raw: string): { normalized: string; tokens: string[] } {
  let value = (raw ?? "")
    .normalize("NFD")
    // Strip diacritics so "Muñoz" and "Munoz" screen alike.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  // "Smith, John" -> "john smith". Only for a single comma with content on
  // both sides, so "Acme, Inc." isn't reordered into nonsense (its suffix
  // is dropped below anyway).
  const commaParts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length === 2 && !ENTITY_SUFFIXES.has(commaParts[1]!.replace(/[^a-z0-9]/g, ""))) {
    value = `${commaParts[1]} ${commaParts[0]}`;
  }

  const tokens = value
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t))
    .filter((t) => !SUFFIXES.has(t))
    .filter((t) => !ENTITY_SUFFIXES.has(t));

  return { normalized: tokens.join(" "), tokens };
}

/**
 * Compares two names, returning how strongly they match or `undefined`
 * for no match.
 *
 * - `exact`    — identical once normalized.
 * - `strong`   — every token of the shorter name appears in the longer
 *                one ("John Smith" vs "John Quincy Smith"), or a
 *                single-token name matches a token of a multi-token name
 *                (an organization referred to by its distinctive word).
 * - `possible` — same surname *and* same first initial ("J. Smith" vs
 *                "John Smith"). Weak on purpose: cheap for a human to
 *                dismiss, expensive to have missed.
 */
export function compareNames(a: string, b: string): MatchStrength | undefined {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left.normalized || !right.normalized) return undefined;
  if (left.normalized === right.normalized) return "exact";

  const [shorter, longer] = left.tokens.length <= right.tokens.length ? [left, right] : [right, left];
  const longerSet = new Set(longer.tokens);

  // A bare single token only counts if it's distinctive enough to be worth
  // surfacing; two characters ("jo", "ab") would match half the world.
  if (shorter.tokens.length === 1) {
    const token = shorter.tokens[0]!;
    if (token.length >= 3 && longerSet.has(token)) return "strong";
  } else if (shorter.tokens.every((t) => longerSet.has(t))) {
    return "strong";
  }

  const lastA = left.tokens[left.tokens.length - 1];
  const lastB = right.tokens[right.tokens.length - 1];
  if (lastA && lastB && lastA === lastB && left.tokens.length > 1 && right.tokens.length > 1) {
    if (left.tokens[0]![0] === right.tokens[0]![0]) return "possible";
  }

  return undefined;
}

/**
 * Severity is a function of adversity plus whether the existing matter is
 * still live. The party's own note is never consulted — only structural
 * facts — so this stays predictable.
 */
function classify(matter: Matter, party: MatterParty, incomingRole: PartyRole): {
  severity: ConflictSeverity;
  explanation: string;
} {
  const live = matter.status !== "closed";
  const adverseToUs = incomingRole === "adverse";
  const theyAreClient = party.role === "client";
  const theyAreAdverse = party.role === "adverse";

  // Rule 1.7: acting against a current client, from either direction.
  if (live && ((adverseToUs && theyAreClient) || (incomingRole === "client" && theyAreAdverse))) {
    return {
      severity: "direct",
      explanation:
        `Directly adverse to an open matter: this name is ${party.role} on '${matter.matterId}', which is ${matter.status}. ` +
        "ABA Model Rule 1.7 normally bars taking this on without informed consent, and Rule 1.10 imputes it to the whole firm.",
    };
  }

  // Rule 1.9: the same adversity, but the matter is closed.
  if (!live && ((adverseToUs && theyAreClient) || (incomingRole === "client" && theyAreAdverse))) {
    return {
      severity: "former_client",
      explanation:
        `Adverse to a former client: this name is ${party.role} on closed matter '${matter.matterId}'. ` +
        "Rule 1.9 turns on whether the two matters are substantially related — an attorney needs to make that call.",
    };
  }

  if (theyAreClient && incomingRole === "client") {
    return {
      severity: "same_side",
      explanation:
        `Already a client on '${matter.matterId}' (${matter.status}). Usually fine, but confirm this isn't a joint ` +
        "representation whose interests could diverge.",
    };
  }

  return {
    severity: "informational",
    explanation: `Appears as ${party.role} on '${matter.matterId}' (${matter.status}). No adversity detected — confirm it's the same person.`,
  };
}

const SEVERITY_ORDER: Record<ConflictSeverity, number> = {
  direct: 0,
  former_client: 1,
  same_side: 2,
  informational: 3,
};
const STRENGTH_ORDER: Record<MatchStrength, number> = { exact: 0, strong: 1, possible: 2 };

export class ConflictChecker {
  #matters: MatterStore;

  constructor(matters: MatterStore) {
    this.#matters = matters;
  }

  /**
   * Screens names against every matter in the firm — not just the
   * caller's own — because Rule 1.10 imputes one lawyer's conflict to
   * everyone. Callers are responsible for gating *who* may run a check;
   * a check that only searched what you can already see would be
   * worthless.
   */
  check(request: ConflictCheckRequest): ConflictCheckResult {
    const hits: ConflictHit[] = [];
    const names = request.names.map((n) => n.trim()).filter(Boolean);

    for (const matter of this.#matters.listAll()) {
      if (request.excludeMatterId && matter.matterId === request.excludeMatterId) continue;
      for (const party of matter.parties) {
        for (const searchedName of names) {
          const matchStrength = compareNames(searchedName, party.name);
          if (!matchStrength) continue;
          const incomingRole = request.roleByName?.[searchedName] ?? "client";
          const { severity, explanation } = classify(matter, party, incomingRole);
          hits.push({
            searchedName,
            matterId: matter.matterId,
            matterTitle: matter.title,
            matterStatus: matter.status,
            matchedParty: { ...party },
            matchedName: party.name,
            matchStrength,
            severity,
            explanation,
          });
        }
      }
    }

    hits.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        STRENGTH_ORDER[a.matchStrength] - STRENGTH_ORDER[b.matchStrength] ||
        a.matterId.localeCompare(b.matterId),
    );

    return {
      hits,
      // "same_side" and "informational" are worth showing but don't by
      // themselves stop an intake; adversity does.
      requiresAttorneyReview: hits.some((h) => h.severity === "direct" || h.severity === "former_client"),
      checkedAt: new Date().toISOString(),
    };
  }
}
