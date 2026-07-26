/**
 * Card/ACH charging, behind a vendor-agnostic interface — the same
 * pattern as `SpeechToText`, `CaseLawSearchClient` and `ClaudeClient`
 * elsewhere in this directory. Nothing above this file knows which
 * processor (if any) is configured.
 *
 * **The compliance point that drives this design:** a law firm cannot
 * let a processor deduct its fees from an account holding client trust
 * funds. Most general-purpose processors net their fee out of the
 * deposit, which for a trust account means the balance no longer equals
 * the sum of client ledgers — the exact condition
 * `TrustLedger.reconcile()` exists to catch, and a serious violation.
 * Legal-specific processors (LawPay and similar) solve this by routing
 * fees to the operating account. Whichever is wired in later, that
 * property is the thing to verify.
 *
 * Because of that, `charge()` here is only ever used for *operating*
 * receipts — paying an invoice. Applying money a client already has in
 * trust never goes through a processor at all; it's a ledger movement
 * (see `invoicing-service.ts`).
 */
export interface ChargeRequest {
  amountCents: number;
  /** Free-text shown on the client's statement where the processor supports it. */
  description: string;
  /** Our own reference (invoice number), so a processor record can be traced back. */
  reference: string;
  /** Opaque, processor-specific payment instrument token. Never a raw card number — see the note below. */
  instrumentToken?: string;
}

export interface ChargeResult {
  /** The processor's transaction id, stored on the `Payment` for reconciliation. */
  processorRef: string;
  status: "succeeded" | "pending";
}

export interface PaymentProcessor {
  readonly name: string;
  /** Whether this processor can actually move money, or only record it. */
  readonly canCharge: boolean;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/**
 * The default: records the intent to take payment without contacting
 * anyone. This is what makes the invoicing system fully usable before
 * any processor is chosen — a firm taking checks, cash, or card payments
 * through a terminal they already own records them here and reconciles
 * against their own bank statement, exactly as they would on paper.
 *
 * It reports `canCharge: false` so callers can tell the difference
 * between "payment taken" and "payment recorded", and never invents a
 * transaction id that looks like a processor's.
 */
export class ManualPaymentProcessor implements PaymentProcessor {
  readonly name = "manual";
  readonly canCharge = false;

  async charge(): Promise<ChargeResult> {
    throw new Error(
      "no payment processor is configured — record the payment manually instead (check, cash, or a terminal you already use)",
    );
  }
}

/**
 * Note for whoever wires a real processor in: card data must never reach
 * this server. Use the processor's client-side tokenization so the
 * browser exchanges card details for a token directly with them, and
 * pass only that token as `instrumentToken`. Accepting raw card numbers
 * here would pull this whole application into PCI-DSS scope, on top of
 * the trust-account problem described above.
 */
