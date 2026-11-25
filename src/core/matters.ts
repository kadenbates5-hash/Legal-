import { isCalendarDate } from "./calendar-date.js";

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
  /**
   * Where to reach them. Only ever used for the *client* party, to email
   * an invoice — this system has no reason to contact an adverse party,
   * and doing so would be a serious mistake, so `billingEmailFor()`
   * below will only ever return a client's.
   */
  email: string | undefined;
  /**
   * Same reasoning as `email`, for SMS appointment reminders (see
   * `integrations/appointment-reminders.ts`) — only ever read for the
   * client party via `clientPhoneFor()` below. Expected in E.164 format
   * (`+15551234567`); `assertSafePhoneNumber()` in `sms-sender.ts` is
   * where that's actually enforced, at send time.
   */
  phone: string | undefined;
}

/**
 * The address an invoice for this matter should go to: the first client
 * party with one on record. Returns undefined rather than falling back
 * to any other party — mailing a bill to the opposing side would be far
 * worse than not mailing it at all.
 */
/**
 * Adds whole years to an ISO date. Used to derive a retention date from
 * the firm's retention period; February 29 lands on the 28th in a
 * non-leap year rather than silently rolling into March.
 */
/**
 * How long a closed file is kept, in whole years (0 means no retention
 * date). The value comes from the firm's config file and, for one close,
 * the API — and neither was checked: a config file saying
 * `"fileRetentionYears": "7"` made `addYears` concatenate, stamping a
 * retention date in the year 20267, and 2.5 stored the date "2028.5-11-25",
 * which no review list ever finds. A numeric string is read as its
 * number, since what was meant is clear; anything else is refused, at
 * boot for the config file.
 */
export const MAX_RETENTION_YEARS = 100;

export function checkedRetentionYears(value: unknown, source: string): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_RETENTION_YEARS) {
    throw new Error(`${source} must be a whole number of years from 0 to ${MAX_RETENTION_YEARS} (got ${JSON.stringify(value)})`);
  }
  return n;
}

export function addYears(isoDate: string, years: number): string {
  if (!Number.isInteger(years)) throw new Error(`years must be a whole number (got ${String(years)})`);
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  const targetYear = y + years;
  const daysInMonth = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  return `${targetYear}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysInMonth)).padStart(2, "0")}`;
}

export function billingEmailFor(matter: Matter | undefined): string | undefined {
  return matter?.parties.find((p) => p.role === "client" && p.email?.trim())?.email?.trim();
}

/** The phone number an SMS appointment reminder for this matter should go to — see `MatterParty.phone`'s doc comment for why only ever a client's. */
export function clientPhoneFor(matter: Matter | undefined): string | undefined {
  return matter?.parties.find((p) => p.role === "client" && p.phone?.trim())?.phone?.trim();
}

/**
 * An informal date worth keeping on the matter record for quick
 * reference — "arraignment", "statute of limitations runs" — distinct
 * from `core/deadline.ts`'s `DeadlineTracker`, which is specifically
 * for dates that need independent, redundant verification before an
 * attorney can rely on them. This is a single-sourced memo, not a
 * substitute for that: nothing here requires a second source to agree,
 * and nothing here blocks a draft's approval the way an unconfirmed
 * tracked deadline does.
 */
export interface MatterKeyDate {
  label: string;
  date: string;
}

export interface Matter {
  matterId: string;
  /** Human-facing caption, e.g. "State v. Ruiz". */
  title: string;
  status: MatterStatus;
  practiceAreaId: string | undefined;
  responsibleAttorneyId: string | undefined;
  description: string | undefined;
  /** The court or tribunal this matter is before, e.g. "Superior Court of California, County of Los Angeles". */
  court: string | undefined;
  /** The court's own docket/case number — never this system's `matterId`, which is an internal filing key. */
  caseNumber: string | undefined;
  /** Free text (name, firm, contact) for the attorney representing the other side — distinct from `parties`, which names the adverse *client*, not their counsel. */
  opposingCounsel: string | undefined;
  keyDates: MatterKeyDate[];
  parties: MatterParty[];
  openedAt: string;
  closedAt: string | undefined;
  /**
   * The date until which the client file must be kept, set when the
   * matter is closed from the firm's retention period. Purely a record:
   * nothing in this system deletes anything when it passes. Destroying a
   * client file is a decision with notice obligations attached, and
   * software that quietly shredded files on a timer would be creating
   * malpractice exposure rather than reducing it.
   */
  retentionUntil: string | undefined;
  /** Why it was closed — the disposition, in the closing attorney's words. */
  closingNote: string | undefined;
  updatedAt: string;
}

export interface MatterInput {
  title?: string;
  status?: MatterStatus;
  practiceAreaId?: string;
  responsibleAttorneyId?: string;
  description?: string;
  court?: string;
  caseNumber?: string;
  opposingCounsel?: string;
  keyDates?: MatterKeyDate[];
  parties?: MatterParty[];
  retentionUntil?: string;
  closingNote?: string;
}

const MATTER_STATUSES: readonly string[] = ["prospective", "open", "closed"];
const PARTY_ROLES: readonly string[] = ["client", "adverse", "related"];

/**
 * A party's side, read forgivingly — "Adverse" and " adverse " are
 * adverse — or undefined when it names no side at all. Every conflicts
 * check reads this field, and before it was checked a party saved as
 * "Adverse" or "opposing party" screened as merely informational: a
 * Rule 1.7 conflict that required no attorney review. An unknown role is
 * refused rather than guessed at, because guessing the wrong side is
 * exactly how a conflict is missed.
 */
export function partyRoleFrom(value: unknown): PartyRole | undefined {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PARTY_ROLES.includes(role) ? (role as PartyRole) : undefined;
}

function matterStatusFrom(value: unknown): MatterStatus | undefined {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MATTER_STATUSES.includes(status) ? (status as MatterStatus) : undefined;
}

export class MatterStore {
  #byId = new Map<string, Matter>();

  /**
   * Creates or updates the record for a matter id. Upsert rather than
   * separate create/update because a matter id can already be in use by
   * work product or documents long before anyone fills in who the client
   * is — the record catches up with reality, it doesn't gate it.
   */
  upsert(
    matterId: string,
    input: MatterInput,
    /**
     * Only the import tool (`data-import.ts`) passes this: a matter brought
     * over from another system was opened (and perhaps closed) years ago,
     * and stamping today's date would misdate it — and its retention
     * period. Never reachable from an HTTP body, and it never overrides a
     * date an existing record already has.
     */
    historical: { openedAt?: string; closedAt?: string } = {},
  ): Matter {
    const id = matterId.trim();
    if (!id) throw new Error("matterId is required");
    const now = new Date().toISOString();
    const existing = this.#byId.get(id);
    let inputStatus: MatterStatus | undefined;
    if (input.status !== undefined) {
      inputStatus = matterStatusFrom(input.status);
      if (!inputStatus) throw new Error(`status must be prospective, open or closed (got '${String(input.status)}')`);
    }
    const parties = input.parties?.map((p) => {
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!name) throw new Error("every party needs a name");
      const role = partyRoleFrom(p.role);
      if (!role) {
        throw new Error(`party '${name}' has role '${String(p.role)}' — it must be client, adverse or related`);
      }
      return { ...p, name, role };
    });
    for (const d of input.keyDates ?? []) {
      if (typeof d.label !== "string" || !d.label.trim()) throw new Error("every key date needs a label");
      if (!isCalendarDate(d.date)) {
        throw new Error(`key date '${d.label}' must be a date in YYYY-MM-DD form (got '${String(d.date)}')`);
      }
    }
    const status = inputStatus ?? existing?.status ?? "open";
    const record: Matter = {
      matterId: id,
      title: input.title ?? existing?.title ?? id,
      status,
      practiceAreaId: input.practiceAreaId ?? existing?.practiceAreaId,
      responsibleAttorneyId: input.responsibleAttorneyId ?? existing?.responsibleAttorneyId,
      description: input.description ?? existing?.description,
      court: input.court ?? existing?.court,
      caseNumber: input.caseNumber ?? existing?.caseNumber,
      opposingCounsel: input.opposingCounsel ?? existing?.opposingCounsel,
      keyDates: (input.keyDates ?? existing?.keyDates ?? []).map((d) => ({ ...d })),
      parties: (parties ?? existing?.parties ?? []).map((p) => ({ ...p })),
      openedAt: existing?.openedAt ?? historical.openedAt ?? now,
      // Closing stamps a date; reopening clears it, so "closed" and
      // "closedAt" can never disagree.
      closedAt: status === "closed" ? existing?.closedAt ?? historical.closedAt ?? now : undefined,
      // Retention and the closing note belong to a closed file. Reopening
      // clears them rather than leaving a stale retention date on a live
      // matter, which would eventually surface it as "due for review"
      // while work is still going on.
      retentionUntil: status === "closed" ? input.retentionUntil ?? existing?.retentionUntil : undefined,
      closingNote: status === "closed" ? input.closingNote ?? existing?.closingNote : undefined,
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
    return this.listAll().map((m) => ({
      ...m,
      parties: m.parties.map((p) => ({ ...p })),
      keyDates: m.keyDates.map((d) => ({ ...d })),
    }));
  }

  static fromSnapshot(snapshot: readonly Matter[]): MatterStore {
    const store = new MatterStore();
    for (const m of snapshot) {
      store.#byId.set(m.matterId, {
        ...m,
        parties: (m.parties ?? []).map((p) => ({ ...p })),
        keyDates: (m.keyDates ?? []).map((d) => ({ ...d })),
      });
    }
    return store;
  }
}
