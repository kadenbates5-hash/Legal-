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
  return compareNormalized(normalizeName(a), normalizeName(b));
}

type NormalizedName = ReturnType<typeof normalizeName>;

/** `compareNames` over names already normalized, so a firm-wide audit normalizes each party once rather than once per comparison. */
function compareNormalized(left: NormalizedName, right: NormalizedName): MatchStrength | undefined {
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

/** Which side a role puts someone on; an unrecognised role is both, so it can't hide a conflict. */
function sidesOf(role: string): { client: boolean; adverse: boolean } {
  const r = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (r === "client") return { client: true, adverse: false };
  if (r === "adverse") return { client: false, adverse: true };
  if (r === "related") return { client: false, adverse: false };
  return { client: true, adverse: true };
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
  // A role this checker doesn't recognise — on a record saved before roles
  // were checked, or in a request — counts as possibly either side, so it
  // over-matches the way the rest of this file does rather than passing
  // as "informational".
  const theirs = sidesOf(party.role);
  const ours = sidesOf(incomingRole);
  const adverseToUs = ours.adverse;
  const theyAreClient = theirs.client;
  const theyAreAdverse = theirs.adverse;

  // Rule 1.7: acting against a current client, from either direction.
  if (live && ((adverseToUs && theyAreClient) || (ours.client && theyAreAdverse))) {
    return {
      severity: "direct",
      explanation:
        `Directly adverse to an open matter: this name is ${party.role} on '${matter.matterId}', which is ${matter.status}. ` +
        "ABA Model Rule 1.7 normally bars taking this on without informed consent, and Rule 1.10 imputes it to the whole firm.",
    };
  }

  // Rule 1.9: the same adversity, but the matter is closed.
  if (!live && ((adverseToUs && theyAreClient) || (ours.client && theyAreAdverse))) {
    return {
      severity: "former_client",
      explanation:
        `Adverse to a former client: this name is ${party.role} on closed matter '${matter.matterId}'. ` +
        "Rule 1.9 turns on whether the two matters are substantially related — an attorney needs to make that call.",
    };
  }

  if (theyAreClient && ours.client) {
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

/* ===== Firm-wide audit =====
   A conflicts *check* asks "does this new name collide with anything we
   already have?" at the moment a matter is opened. An *audit* asks the
   question the check can't: does the firm's book, as it stands today,
   already have someone on both sides? That happens in perfectly ordinary
   ways — a party added to a matter months after it was screened, two
   matters opened by different attorneys the same week, a closed file
   reopened, an import from another system — and nothing else in the
   system would ever notice. */

/**
 * How seriously to read an audit finding, worst first:
 *
 * - `current_adversity` — client on one live matter, adverse on another
 *   live matter (or on the same one). The Rule 1.7 case.
 * - `former_client_adversity` — a former client (closed matter) is
 *   adverse on a live matter. Rule 1.9; whether the matters are
 *   substantially related is an attorney's call.
 * - `past_adversity` — the firm acted against this person on a matter
 *   that is now closed, and represents them elsewhere. Rarely a conflict
 *   on its own, but the firm still owes the client it had on that
 *   earlier matter (Rule 1.9).
 * - `review` — not adversity at all: one client recorded under two
 *   spellings, or two different people whose names will keep matching.
 */
export type ConflictAuditSeverity = "current_adversity" | "former_client_adversity" | "past_adversity" | "review";

export interface ConflictAuditAppearance {
  matterId: string;
  matterTitle: string;
  matterStatus: Matter["status"];
  /** The name exactly as that matter records it. */
  name: string;
  role: "client" | "adverse";
  note: string | undefined;
}

export interface ConflictAuditFinding {
  kind: "opposite_sides" | "spelling_variant";
  severity: ConflictAuditSeverity;
  /** How closely the recorded names match; `exact` means identical once normalized. */
  matchStrength: MatchStrength;
  /** True when one matter lists the same name on both sides. */
  sameMatter: boolean;
  appearances: ConflictAuditAppearance[];
  /** Plain-language reason, written to be read by an attorney working down a list. */
  explanation: string;
}

export interface ConflictAuditReport {
  findings: ConflictAuditFinding[];
  /** Every finding, including any beyond `findings` when the list was cut short. */
  totalFindings: number;
  truncated: boolean;
  countsBySeverity: Record<ConflictAuditSeverity, number>;
  mattersScanned: number;
  partiesCompared: number;
  /** What this audit does not look at — shown with the report, never buried. */
  notCovered: string[];
  generatedAt: string;
}

export const CONFLICT_AUDIT_NOT_COVERED: readonly string[] = [
  "Parties marked 'related' (witnesses, co-defendants, family members) are not compared.",
  "The opposing-counsel field is free text and is not compared.",
  "A client recorded on several matters under the same spelling is a returning client, not a finding, and is not listed.",
  "Only what is written on a matter record here can be found — people never named on one, and matters never entered, are invisible to this audit.",
];

const AUDIT_SEVERITY_ORDER: Record<ConflictAuditSeverity, number> = {
  current_adversity: 0,
  former_client_adversity: 1,
  past_adversity: 2,
  review: 3,
};

interface AuditEntry {
  matter: Matter;
  party: MatterParty & { role: "client" | "adverse" };
}

interface AuditGroup {
  norm: NormalizedName;
  entries: AuditEntry[];
}

function appearanceOf(entry: AuditEntry): ConflictAuditAppearance {
  return {
    matterId: entry.matter.matterId,
    matterTitle: entry.matter.title,
    matterStatus: entry.matter.status,
    name: entry.party.name,
    role: entry.party.role,
    note: entry.party.note,
  };
}

function pairSeverity(client: AuditEntry, adverse: AuditEntry): ConflictAuditSeverity {
  const clientLive = client.matter.status !== "closed";
  const adverseLive = adverse.matter.status !== "closed";
  if (clientLive && adverseLive) return "current_adversity";
  if (!clientLive && adverseLive) return "former_client_adversity";
  return "past_adversity";
}

function quoted(names: Iterable<string>): string {
  return [...new Set(names)].map((n) => `"${n}"`).join(" / ");
}

function matterList(appearances: ConflictAuditAppearance[], role: "client" | "adverse"): string {
  const ids = [...new Set(appearances.filter((a) => a.role === role).map((a) => `'${a.matterId}'`))];
  return ids.join(", ");
}

function explainOpposite(
  severity: ConflictAuditSeverity,
  strength: MatchStrength,
  sameMatterIds: ReadonlySet<string>,
  appearances: ConflictAuditAppearance[],
): string {
  const who = quoted(appearances.map((a) => a.name));
  const clientOn = matterList(appearances, "client");
  const adverseOn = matterList(appearances, "adverse");
  const matterCount = new Set(appearances.map((a) => a.matterId)).size;
  let text: string;
  if (sameMatterIds.size > 0) {
    const ids = [...sameMatterIds].map((id) => `'${id}'`).join(", ");
    text =
      `${who} is recorded as both a client and an adverse party on ${ids}. That is almost always a data-entry ` +
      "mistake — correct the matter record; if it isn't one, the representation can't stand as recorded.";
    // Anything beyond the one matter still needs reading on its own terms.
    if (matterCount > sameMatterIds.size) {
      text += ` The name also appears on other matters: client on ${clientOn}, adverse on ${adverseOn}.`;
    }
  } else if (severity === "current_adversity") {
    text =
      `${who} is a client on ${clientOn} and adverse on ${adverseOn}, and both are open. Rule 1.7: the firm is acting ` +
      "against a current client. Confirm informed consent is on file, or that these are different people.";
  } else if (severity === "former_client_adversity") {
    text =
      `${who} was a client on closed matter ${clientOn} and is adverse on open matter ${adverseOn}. Rule 1.9 turns on ` +
      "whether the matters are substantially related — an attorney needs to make that call.";
  } else {
    text =
      `The firm acted against ${who} on closed matter ${adverseOn} and represents them on ${clientOn}. Usually not a ` +
      "conflict by itself; check that representing them isn't adverse to the client the firm had on that earlier matter (Rule 1.9).";
  }
  if (strength !== "exact") {
    text += ` The names are a ${strength} match, not identical — confirm it's the same person before acting on this.`;
  }
  return text;
}

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

  /**
   * Screens the firm's whole book against itself: every client and
   * adverse party on every matter, compared with every other. Read-only —
   * it changes no record and clears nothing; callers decide who may run
   * it and record that they did.
   *
   * One finding per pair of recorded names (identical names count as one
   * name), listing every matter each side appears on, so "the State is
   * adverse on 400 matters" stays one quiet non-finding rather than
   * 80,000 rows. Names are normalized once each, and only names sharing a
   * token are compared — every match `compareNames` can return needs a
   * shared token — so this stays fast on a firm with thousands of matters.
   */
  audit(options: { maxFindings?: number; now?: Date } = {}): ConflictAuditReport {
    const maxFindings = options.maxFindings ?? 500;
    const matters = this.#matters.listAll();

    const groupsByName = new Map<string, AuditGroup>();
    let partiesCompared = 0;
    for (const matter of matters) {
      for (const party of matter.parties) {
        if (party.role !== "client" && party.role !== "adverse") continue;
        const norm = normalizeName(party.name);
        if (!norm.normalized) continue;
        partiesCompared++;
        let group = groupsByName.get(norm.normalized);
        if (!group) {
          group = { norm, entries: [] };
          groupsByName.set(norm.normalized, group);
        }
        group.entries.push({ matter, party: party as AuditEntry["party"] });
      }
    }
    const groups = [...groupsByName.values()];

    // Blocking. A strong match needs every token of the shorter name in
    // the longer one, so the shorter name's rarest token is always shared;
    // a possible match needs the same last token. Indexing both finds
    // every candidate pair without comparing every name with every other.
    const byToken = new Map<string, number[]>();
    const byLastToken = new Map<string, number[]>();
    groups.forEach((g, i) => {
      for (const token of new Set(g.norm.tokens)) {
        const list = byToken.get(token) ?? [];
        list.push(i);
        byToken.set(token, list);
      }
      const last = g.norm.tokens[g.norm.tokens.length - 1]!;
      const list = byLastToken.get(last) ?? [];
      list.push(i);
      byLastToken.set(last, list);
    });

    const pairs: Array<[number, number, MatchStrength]> = groups.map((_, i) => [i, i, "exact"]);
    const seen = new Set<string>();
    groups.forEach((g, i) => {
      const rarest = g.norm.tokens.reduce((best, t) =>
        (byToken.get(t)?.length ?? 0) < (byToken.get(best)?.length ?? 0) ? t : best,
      );
      const candidates = new Set([
        ...(byToken.get(rarest) ?? []),
        ...(byLastToken.get(g.norm.tokens[g.norm.tokens.length - 1]!) ?? []),
      ]);
      for (const j of candidates) {
        if (j === i) continue;
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const strength = compareNormalized(g.norm, groups[j]!.norm);
        if (strength) pairs.push([Math.min(i, j), Math.max(i, j), strength]);
      }
    });

    const findings: ConflictAuditFinding[] = [];
    for (const [i, j, strength] of pairs) {
      const left = groups[i]!.entries;
      const right = groups[j]!.entries;
      const opposite = new Set<AuditEntry>();
      let worst: ConflictAuditSeverity | undefined;
      const sameMatterIds = new Set<string>();
      let clientVariant = false;

      const consider = (a: AuditEntry, b: AuditEntry) => {
        if (a.party.role !== b.party.role) {
          const [client, adverse] = a.party.role === "client" ? [a, b] : [b, a];
          const severity = pairSeverity(client, adverse);
          if (!worst || AUDIT_SEVERITY_ORDER[severity] < AUDIT_SEVERITY_ORDER[worst]) worst = severity;
          if (a.matter.matterId === b.matter.matterId) sameMatterIds.add(a.matter.matterId);
          opposite.add(a);
          opposite.add(b);
        } else if (a.party.role === "client" && i !== j && strength === "strong") {
          // Strong only. Adversity keeps every possible match — that's
          // where over-matching earns its keep — but "Jane Smith" and
          // "John Smith" as clients are usually two family members, and a
          // spelling list that flags every shared surname is one nobody
          // reads.
          clientVariant = true;
        }
      };

      if (i === j) {
        for (let x = 0; x < left.length; x++) for (let y = x + 1; y < left.length; y++) consider(left[x]!, left[y]!);
      } else {
        for (const a of left) for (const b of right) consider(a, b);
      }

      if (worst) {
        const appearances = [...opposite].map(appearanceOf).sort(
          (a, b) => a.role.localeCompare(b.role) || a.matterId.localeCompare(b.matterId),
        );
        findings.push({
          kind: "opposite_sides",
          severity: worst,
          matchStrength: strength,
          sameMatter: sameMatterIds.size > 0,
          appearances,
          explanation: explainOpposite(worst, strength, sameMatterIds, appearances),
        });
      } else if (clientVariant) {
        // Only when the pair isn't already an adversity finding, which
        // lists both spellings anyway.
        const appearances = [...left, ...right]
          .filter((e) => e.party.role === "client")
          .map(appearanceOf)
          .sort((a, b) => a.matterId.localeCompare(b.matterId));
        findings.push({
          kind: "spelling_variant",
          severity: "review",
          matchStrength: strength,
          sameMatter: false,
          appearances,
          explanation:
            `${quoted(appearances.map((a) => a.name))} are recorded as clients under different spellings. Either it's one ` +
            "client written two ways — use one spelling so the file reads consistently — or two different people, and a " +
            "note on each saying so saves the next person re-checking.",
        });
      }
    }

    findings.sort(
      (a, b) =>
        AUDIT_SEVERITY_ORDER[a.severity] - AUDIT_SEVERITY_ORDER[b.severity] ||
        Number(b.sameMatter) - Number(a.sameMatter) ||
        STRENGTH_ORDER[a.matchStrength] - STRENGTH_ORDER[b.matchStrength] ||
        a.appearances[0]!.name.localeCompare(b.appearances[0]!.name),
    );

    const countsBySeverity: Record<ConflictAuditSeverity, number> = {
      current_adversity: 0,
      former_client_adversity: 0,
      past_adversity: 0,
      review: 0,
    };
    for (const f of findings) countsBySeverity[f.severity]++;

    return {
      findings: findings.slice(0, Math.max(0, maxFindings)),
      totalFindings: findings.length,
      truncated: findings.length > maxFindings,
      countsBySeverity,
      mattersScanned: matters.length,
      partiesCompared,
      notCovered: [...CONFLICT_AUDIT_NOT_COVERED],
      generatedAt: (options.now ?? new Date()).toISOString(),
    };
  }
}
