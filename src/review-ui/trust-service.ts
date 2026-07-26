import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type {
  ReconciliationResult,
  TrustEntry,
  TrustLedger,
  TrustEntryType,
} from "../core/trust-ledger.js";

/**
 * The "Trust" panel's backend, over `core/trust-ledger.ts`.
 *
 * Two gates, for two different risks:
 *
 * - **Matter scoping** via `AccessControl`'s existing
 *   `billing_internal` category, so a paralegal can only see and touch
 *   the trust ledger for their own matter — same as billing hours.
 * - **Money leaving the account is attorney-only.** Recording an
 *   incoming deposit is bookkeeping a paralegal can reasonably do; a
 *   disbursement, a transfer of earned fees to the operating account, or
 *   a refund all move client funds *out*, which in practice requires an
 *   authorized signer. Reversals are attorney-only for the same reason —
 *   a reversal is a movement of money, just in the other direction.
 *
 * Every call here is audited. A trust ledger's value is evidentiary, so
 * "who recorded this, and when" is part of the record, not metadata.
 */
const OUTBOUND_TYPES: ReadonlySet<TrustEntryType> = new Set<TrustEntryType>([
  "disbursement",
  "earned_fee_transfer",
  "refund",
]);

function requireLegalStaff(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`the trust ledger is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

export interface RecordTrustEntryInput {
  type: Exclude<TrustEntryType, "reversal">;
  amountCents: number;
  description: string;
  reference?: string;
}

export interface MatterTrustView {
  matterId: string;
  balanceCents: number;
  entries: TrustEntry[];
}

export class TrustService {
  #ledger: TrustLedger;
  #accessControl: AccessControl;
  #auditLog: AuditLog;

  constructor(params: { ledger: TrustLedger; accessControl: AccessControl; auditLog: AuditLog }) {
    this.#ledger = params.ledger;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
  }

  getMatterLedger(actor: Actor, matterId: string): MatterTrustView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    return {
      matterId,
      balanceCents: this.#ledger.balanceForMatter(matterId),
      entries: this.#ledger.listForMatter(matterId),
    };
  }

  record(actor: Actor, matterId: string, input: RecordTrustEntryInput): TrustEntry {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    if (OUTBOUND_TYPES.has(input.type) && actor.role !== "attorney") {
      throw new AccessDeniedError(
        `moving client funds out of trust ('${input.type}') is attorney-only — recording an incoming deposit is not`,
      );
    }
    const entry = this.#ledger.record({
      matterId,
      type: input.type,
      amountCents: input.amountCents,
      description: input.description,
      ...(input.reference ? { reference: input.reference } : {}),
      recordedBy: actor.id,
    });
    this.#auditLog.append({
      actor,
      matterId,
      action: "trust_entry_recorded",
      detail: `type=${entry.type} amountCents=${entry.amountCents} balanceAfterCents=${entry.balanceAfterCents} entry=${entry.id}`,
    });
    return entry;
  }

  reverse(actor: Actor, matterId: string, entryId: string, reason: string): TrustEntry {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("reversing a trust entry is attorney-only — it moves client funds");
    }
    const original = this.#ledger.listForMatter(matterId).find((e) => e.id === entryId);
    if (!original) {
      // Checked against *this matter's* entries, so an id from another
      // matter can't be reversed by naming it here.
      throw new Error(`no trust entry '${entryId}' on matter '${matterId}'`);
    }
    const entry = this.#ledger.reverse(entryId, actor.id, reason);
    this.#auditLog.append({
      actor,
      matterId,
      action: "trust_entry_reversed",
      detail: `reversed=${entryId} reason=${reason} balanceAfterCents=${entry.balanceAfterCents}`,
    });
    return entry;
  }

  /**
   * Firm-wide reconciliation is attorney-only: it deliberately exposes
   * every matter's balance at once, which is broader than the
   * matter-scoped view above, and reconciling the trust account is a
   * supervisory responsibility rather than a bookkeeping one.
   */
  reconcile(actor: Actor, bankBalanceCents: number): ReconciliationResult {
    if (actor.role !== "attorney") {
      throw new AccessDeniedError(`trust reconciliation is attorney-only (got role '${actor.role}')`);
    }
    const result = this.#ledger.reconcile(bankBalanceCents);
    this.#auditLog.append({
      actor,
      matterId: undefined,
      action: "trust_reconciliation_run",
      detail:
        `bankBalanceCents=${result.bankBalanceCents} ledgerTotalCents=${result.ledgerTotalCents} ` +
        `differenceCents=${result.differenceCents} balanced=${result.balanced}`,
    });
    return result;
  }
}
