/**
 * Client trust accounting (IOLTA).
 *
 * Client funds held in trust are not the firm's money. Mishandling them
 * is among the fastest routes to disbarment there is, and the rules are
 * unusually mechanical — which makes them a good fit for the same
 * treatment this project gives the review gate: **enforced as a code
 * path, not as a policy someone is asked to remember.**
 *
 * Three invariants are structural here and have no configuration knob:
 *
 * 1. **A matter's trust balance can never go below zero.** A negative
 *    sub-ledger means one client's funds paid another client's costs.
 *    That is the cardinal violation, and it is the reason this file
 *    exists rather than a spreadsheet.
 * 2. **Entries are immutable.** A mistake is corrected by recording a
 *    reversing entry, never by editing or deleting history — the same
 *    append-only reasoning as `audit.ts`. A trust ledger you can quietly
 *    edit is not evidence of anything.
 * 3. **Money is integer cents.** Floating-point arithmetic silently
 *    loses fractions of a cent, and a trust ledger that doesn't
 *    reconcile to the penny is a finding in an audit.
 *
 * What this is **not**: a bookkeeping system, a bank integration, or a
 * substitute for the firm's actual reconciliation duties. It records and
 * constrains what the firm enters, and it can tell you when the ledger
 * disagrees with the bank (`reconcile()`); it cannot tell you the bank
 * balance, and it does not know your jurisdiction's specific rules on
 * retainer handling, interest, or unclaimed funds.
 */
export class TrustAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustAccountingError";
  }
}

/**
 * Direction is carried by the type, never by the sign of the amount —
 * amounts are always positive, so a typo'd minus sign can't silently
 * invert a disbursement into a deposit.
 */
export type TrustEntryType =
  /** Client money coming in (retainer, settlement proceeds, cost advance). */
  | "deposit"
  /** Paying a third party on the client's behalf (filing fee, expert, court reporter). */
  | "disbursement"
  /** Moving fees the firm has actually earned out to the operating account. */
  | "earned_fee_transfer"
  /** Returning unearned funds to the client. */
  | "refund"
  /** Corrects a prior entry. Never created directly — see `reverse()`. */
  | "reversal";

const INCREASES_BALANCE: ReadonlySet<TrustEntryType> = new Set<TrustEntryType>(["deposit"]);

export interface TrustEntry {
  readonly id: string;
  readonly matterId: string;
  readonly type: TrustEntryType;
  /** Always positive. Direction comes from `type` (or from the reversed entry, for a reversal). */
  readonly amountCents: number;
  readonly description: string;
  /** Check number, wire reference, deposit slip — whatever ties this to the bank record. */
  readonly reference: string | undefined;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** Set only on a reversal: the id of the entry being corrected. */
  readonly reversalOf: string | undefined;
  /** That matter's running balance immediately after this entry. */
  readonly balanceAfterCents: number;
}

export interface RecordEntryParams {
  matterId: string;
  type: Exclude<TrustEntryType, "reversal">;
  amountCents: number;
  description: string;
  reference?: string;
  recordedBy: string;
}

export interface MatterReconciliation {
  matterId: string;
  balanceCents: number;
}

export interface ReconciliationResult {
  /** What this ledger says the trust account should hold, in total. */
  ledgerTotalCents: number;
  bankBalanceCents: number;
  /** bank − ledger. Non-zero means something is wrong and needs investigating. */
  differenceCents: number;
  balanced: boolean;
  perMatter: MatterReconciliation[];
  reconciledAt: string;
}

export interface TrustLedgerSnapshot {
  entries: TrustEntry[];
  nextId: number;
}

export class TrustLedger {
  #entries: TrustEntry[] = [];
  #nextId = 1;

  /**
   * Records an entry, refusing any that would overdraw the matter.
   * The check happens here rather than at a service or UI layer
   * specifically so there is no path — assistant tool call, HTTP route,
   * future integration — that can bypass it.
   */
  record(params: RecordEntryParams): TrustEntry {
    const matterId = params.matterId.trim();
    if (!matterId) throw new TrustAccountingError("matterId is required");
    this.#assertValidAmount(params.amountCents);
    if (!params.description.trim()) {
      throw new TrustAccountingError("every trust entry needs a description — an unexplained movement of client funds is an audit finding");
    }
    return this.#append({
      matterId,
      type: params.type,
      amountCents: params.amountCents,
      description: params.description.trim(),
      reference: params.reference?.trim() || undefined,
      recordedBy: params.recordedBy,
      reversalOf: undefined,
      signedDelta: INCREASES_BALANCE.has(params.type) ? params.amountCents : -params.amountCents,
    });
  }

  /**
   * Corrects a prior entry by appending its exact inverse. History is
   * never rewritten: both the mistake and the correction remain visible,
   * which is the whole evidentiary point of a trust ledger.
   *
   * A reversal is itself subject to the no-overdraw rule — reversing a
   * deposit that has already been spent would push the matter negative,
   * and that has to fail loudly rather than quietly produce an
   * impossible balance.
   */
  reverse(entryId: string, recordedBy: string, reason: string): TrustEntry {
    const original = this.#entries.find((e) => e.id === entryId);
    if (!original) throw new TrustAccountingError(`no trust entry '${entryId}'`);
    if (original.type === "reversal") {
      throw new TrustAccountingError("a reversal cannot itself be reversed — record a fresh corrective entry instead");
    }
    if (this.#entries.some((e) => e.reversalOf === entryId)) {
      throw new TrustAccountingError(`entry '${entryId}' has already been reversed`);
    }
    if (!reason.trim()) throw new TrustAccountingError("a reversal needs a reason");

    // Exactly undo the original's effect on the balance.
    const signedDelta = INCREASES_BALANCE.has(original.type) ? -original.amountCents : original.amountCents;
    return this.#append({
      matterId: original.matterId,
      type: "reversal",
      amountCents: original.amountCents,
      description: `Reversal of ${original.id}: ${reason.trim()}`,
      reference: original.reference,
      recordedBy,
      reversalOf: original.id,
      signedDelta,
    });
  }

  balanceForMatter(matterId: string): number {
    const entries = this.#entries.filter((e) => e.matterId === matterId);
    return entries.length === 0 ? 0 : entries[entries.length - 1]!.balanceAfterCents;
  }

  listForMatter(matterId: string): TrustEntry[] {
    return this.#entries.filter((e) => e.matterId === matterId).map((e) => ({ ...e }));
  }

  listAll(): TrustEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  /** Every matter that has ever held funds, including those now at zero. */
  matterIds(): string[] {
    return [...new Set(this.#entries.map((e) => e.matterId))];
  }

  totalBalanceCents(): number {
    return this.matterIds().reduce((sum, id) => sum + this.balanceForMatter(id), 0);
  }

  /**
   * The ledger side of a three-way reconciliation: the sum of every
   * client's sub-ledger must equal the trust account's actual bank
   * balance. A non-zero difference is not something to round away — it
   * means funds are missing, misposted, or unrecorded.
   *
   * The third leg (the bank's own statement) necessarily comes from
   * outside this system; the caller supplies it.
   */
  reconcile(bankBalanceCents: number): ReconciliationResult {
    if (!Number.isInteger(bankBalanceCents)) {
      throw new TrustAccountingError("bank balance must be an integer number of cents");
    }
    const ledgerTotalCents = this.totalBalanceCents();
    return {
      ledgerTotalCents,
      bankBalanceCents,
      differenceCents: bankBalanceCents - ledgerTotalCents,
      balanced: bankBalanceCents === ledgerTotalCents,
      perMatter: this.matterIds()
        .map((matterId) => ({ matterId, balanceCents: this.balanceForMatter(matterId) }))
        .sort((a, b) => a.matterId.localeCompare(b.matterId)),
      reconciledAt: new Date().toISOString(),
    };
  }

  #assertValidAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents)) {
      throw new TrustAccountingError("amount must be an integer number of cents — fractional cents don't reconcile");
    }
    if (amountCents <= 0) {
      throw new TrustAccountingError("amount must be positive; the entry type carries the direction");
    }
  }

  #append(params: {
    matterId: string;
    type: TrustEntryType;
    amountCents: number;
    description: string;
    reference: string | undefined;
    recordedBy: string;
    reversalOf: string | undefined;
    signedDelta: number;
  }): TrustEntry {
    const balanceAfterCents = this.balanceForMatter(params.matterId) + params.signedDelta;
    if (balanceAfterCents < 0) {
      throw new TrustAccountingError(
        `refusing to overdraw matter '${params.matterId}': balance would go to ${balanceAfterCents} cents. ` +
          "A negative client trust balance means one client's funds are covering another's — never permitted.",
      );
    }
    const entry: TrustEntry = Object.freeze({
      id: `trust_${this.#nextId++}`,
      matterId: params.matterId,
      type: params.type,
      amountCents: params.amountCents,
      description: params.description,
      reference: params.reference,
      recordedBy: params.recordedBy,
      recordedAt: new Date().toISOString(),
      reversalOf: params.reversalOf,
      balanceAfterCents,
    });
    this.#entries.push(entry);
    return entry;
  }

  toSnapshot(): TrustLedgerSnapshot {
    return { entries: this.listAll(), nextId: this.#nextId };
  }

  static fromSnapshot(snapshot: TrustLedgerSnapshot): TrustLedger {
    const ledger = new TrustLedger();
    ledger.#entries = (snapshot.entries ?? []).map((e) => Object.freeze({ ...e }));
    ledger.#nextId = snapshot.nextId ?? ledger.#entries.length + 1;
    return ledger;
  }
}

/** Presentation helper — cents to a plain decimal string, no locale surprises. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
