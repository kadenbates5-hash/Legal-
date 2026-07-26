import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl } from "../core/access-control.js";
import type { AuditLog } from "../core/audit.js";
import type { BillingHoursStore } from "../core/billing-hours.js";
import type { TrustLedger } from "../core/trust-ledger.js";
import {
  InvoicingError,
  type Invoice,
  type InvoiceStore,
  type InvoiceTotals,
  type LineItemSource,
  type Payment,
  type PaymentMethod,
} from "../core/invoicing.js";
import type { PaymentProcessor } from "../integrations/payment-processor.js";

function requireLegalStaff(actor: Actor): void {
  if (actor.role !== "paralegal" && actor.role !== "attorney") {
    throw new AccessDeniedError(`invoicing is paralegal/attorney-only (got role '${actor.role}')`);
  }
}

export interface InvoiceView extends Invoice {
  totals: InvoiceTotals;
  payments: Payment[];
}

/**
 * Backs the "Invoices" panel.
 *
 * Matter-scoped through `AccessControl`'s `billing_internal` category,
 * like billing hours and the trust ledger. Two things are attorney-only
 * on top of that, both because they're the points where a bill becomes
 * real: **sending** an invoice to a client, and **voiding** one. A
 * paralegal can build the draft; committing it is a supervisory act.
 *
 * The most important method here is `payFromTrust`. Applying money the
 * firm already holds for a client is not a payment in the ordinary
 * sense — it's the firm transferring client funds to itself, which is
 * only permissible for fees actually earned. So it does two things
 * atomically-in-intent: writes an `earned_fee_transfer` to the trust
 * ledger (where the no-overdraw rule applies) *and* records the
 * corresponding payment against the invoice. The trust movement is
 * attempted first, so if the client doesn't have the funds, nothing is
 * recorded anywhere.
 */
export class InvoicingService {
  #store: InvoiceStore;
  #accessControl: AccessControl;
  #auditLog: AuditLog;
  #trust: TrustLedger;
  #billingHours: BillingHoursStore;
  #processor: PaymentProcessor;

  constructor(params: {
    store: InvoiceStore;
    accessControl: AccessControl;
    auditLog: AuditLog;
    trust: TrustLedger;
    billingHours: BillingHoursStore;
    processor: PaymentProcessor;
  }) {
    this.#store = params.store;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#trust = params.trust;
    this.#billingHours = params.billingHours;
    this.#processor = params.processor;
  }

  /** Whether a real processor is wired up, so the UI can say "record payment" rather than offering to charge a card that will fail. */
  processorInfo(actor: Actor): { name: string; canCharge: boolean } {
    requireLegalStaff(actor);
    return { name: this.#processor.name, canCharge: this.#processor.canCharge };
  }

  listForMatter(actor: Actor, matterId: string): InvoiceView[] {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    return this.#store.listByMatter(matterId).map((i) => this.#view(i));
  }

  get(actor: Actor, matterId: string, invoiceId: string): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    return this.#view(this.#requireOnMatter(matterId, invoiceId));
  }

  createDraft(actor: Actor, matterId: string, params: { dueDate?: string; note?: string }): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#store.createDraft({
      matterId,
      issuedBy: actor.id,
      ...(params.dueDate ? { dueDate: params.dueDate } : {}),
      ...(params.note ? { note: params.note } : {}),
    });
    this.#audit(actor, matterId, "invoice_created", `invoice=${invoice.number}`);
    return this.#view(invoice);
  }

  addLineItem(
    actor: Actor,
    matterId: string,
    invoiceId: string,
    params: { description: string; source: LineItemSource; quantityMilli: number; unitAmountCents: number },
  ): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    this.#store.addLineItem(invoice.id, params);
    return this.#view(invoice);
  }

  removeLineItem(actor: Actor, matterId: string, invoiceId: string, lineItemId: string): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    this.#store.removeLineItem(invoice.id, lineItemId);
    return this.#view(invoice);
  }

  /**
   * Pulls this matter's logged billable hours onto the draft as `time`
   * lines at a rate the caller supplies. The rate isn't stored on the
   * time entries themselves because the same work can be billed at
   * different rates (a courtesy discount, a fee agreement cap) and the
   * invoice is where that decision belongs.
   */
  addTimeFromBillingHours(actor: Actor, matterId: string, invoiceId: string, hourlyRateCents: number): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    const entries = this.#billingHours.listByMatter(matterId);
    if (entries.length === 0) throw new InvoicingError(`no logged billable hours on matter '${matterId}'`);
    for (const entry of entries) {
      this.#store.addLineItem(invoice.id, {
        description: `${entry.date} — ${entry.description}`,
        source: "time",
        quantityMilli: Math.round(entry.hours * 1000),
        unitAmountCents: hourlyRateCents,
      });
    }
    this.#audit(actor, matterId, "invoice_time_added", `invoice=${invoice.number} entries=${entries.length}`);
    return this.#view(invoice);
  }

  send(actor: Actor, matterId: string, invoiceId: string): InvoiceView {
    requireLegalStaff(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("sending an invoice to a client is attorney-only — a paralegal can prepare the draft");
    }
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#store.send(this.#requireOnMatter(matterId, invoiceId).id);
    this.#audit(actor, matterId, "invoice_sent", `invoice=${invoice.number} totalCents=${this.#store.subtotal(invoice.id)}`);
    return this.#view(invoice);
  }

  void(actor: Actor, matterId: string, invoiceId: string, reason: string): InvoiceView {
    requireLegalStaff(actor);
    if (actor.role !== "attorney") throw new AccessDeniedError("voiding an invoice is attorney-only");
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#store.void(this.#requireOnMatter(matterId, invoiceId).id, reason);
    this.#audit(actor, matterId, "invoice_voided", `invoice=${invoice.number} reason=${reason}`);
    return this.#view(invoice);
  }

  /** Records money received outside the app (check, cash, an existing card terminal). */
  recordPayment(
    actor: Actor,
    matterId: string,
    invoiceId: string,
    params: { amountCents: number; method: PaymentMethod; reference?: string },
  ): InvoiceView {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    if (params.method === "trust_application") {
      throw new InvoicingError("applying trust funds must go through payFromTrust so the trust ledger is updated too");
    }
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    const payment = this.#store.recordPayment({
      invoiceId: invoice.id,
      amountCents: params.amountCents,
      method: params.method,
      ...(params.reference ? { reference: params.reference } : {}),
      recordedBy: actor.id,
    });
    this.#audit(
      actor,
      matterId,
      "invoice_payment_recorded",
      `invoice=${invoice.number} amountCents=${payment.amountCents} method=${payment.method}`,
    );
    return this.#view(invoice);
  }

  /**
   * Charges a card/ACH through the configured processor, then records
   * the resulting payment. Only ever touches the *operating* side —
   * client funds already in trust are applied via `payFromTrust`, never
   * round-tripped through a processor, which is what keeps processor
   * fees off the trust account.
   */
  async chargePayment(
    actor: Actor,
    matterId: string,
    invoiceId: string,
    params: { amountCents: number; instrumentToken?: string },
  ): Promise<InvoiceView> {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    const result = await this.#processor.charge({
      amountCents: params.amountCents,
      description: `Invoice ${invoice.number}`,
      reference: invoice.number,
      ...(params.instrumentToken ? { instrumentToken: params.instrumentToken } : {}),
    });
    this.#store.recordPayment({
      invoiceId: invoice.id,
      amountCents: params.amountCents,
      method: "card",
      reference: result.processorRef,
      recordedBy: actor.id,
    });
    this.#audit(
      actor,
      matterId,
      "invoice_payment_charged",
      `invoice=${invoice.number} amountCents=${params.amountCents} processor=${this.#processor.name} ref=${result.processorRef}`,
    );
    return this.#view(invoice);
  }

  /**
   * Applies funds already held in trust to an invoice. Attorney-only:
   * moving client money to the firm is only permissible for fees
   * actually earned, and that determination is an attorney's.
   *
   * The trust withdrawal is attempted **first**. If the client's trust
   * balance can't cover it, `TrustLedger` throws and no payment is
   * recorded — the two records can't disagree about whether the money
   * moved.
   */
  payFromTrust(actor: Actor, matterId: string, invoiceId: string, amountCents: number): InvoiceView {
    requireLegalStaff(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError(
        "applying trust funds to an invoice is attorney-only — it moves client money to the firm and requires the fees to have been earned",
      );
    }
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);

    // Check the invoice side before touching trust, so a rejected payment
    // can't leave an orphaned withdrawal behind.
    const { balanceCents } = this.#store.totals(invoice.id);
    if (invoice.status === "draft") throw new InvoicingError("send the invoice before applying trust funds to it");
    if (invoice.status === "void") throw new InvoicingError("cannot apply funds to a voided invoice");
    if (amountCents > balanceCents) {
      throw new InvoicingError(`amount exceeds the ${balanceCents}-cent balance on ${invoice.number}`);
    }

    const trustEntry = this.#trust.record({
      matterId,
      type: "earned_fee_transfer",
      amountCents,
      description: `Applied to invoice ${invoice.number}`,
      reference: invoice.number,
      recordedBy: actor.id,
    });
    this.#store.recordPayment({
      invoiceId: invoice.id,
      amountCents,
      method: "trust_application",
      reference: trustEntry.id,
      recordedBy: actor.id,
    });
    this.#audit(
      actor,
      matterId,
      "invoice_paid_from_trust",
      `invoice=${invoice.number} amountCents=${amountCents} trustEntry=${trustEntry.id} trustBalanceAfterCents=${trustEntry.balanceAfterCents}`,
    );
    return this.#view(invoice);
  }

  #view(invoice: Invoice): InvoiceView {
    return {
      ...invoice,
      lineItems: invoice.lineItems.map((l) => ({ ...l })),
      totals: this.#store.totals(invoice.id),
      payments: this.#store.paymentsFor(invoice.id),
    };
  }

  #requireOnMatter(matterId: string, invoiceId: string): Invoice {
    const invoice = this.#store.get(invoiceId);
    if (!invoice || invoice.matterId !== matterId) {
      throw new InvoicingError(`no invoice '${invoiceId}' on matter '${matterId}'`);
    }
    return invoice;
  }

  #audit(actor: Actor, matterId: string, action: string, detail: string): void {
    this.#auditLog.append({ actor, matterId, action, detail });
  }
}
