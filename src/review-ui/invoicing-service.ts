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
import { assertSafeEmailAddress, type EmailSender } from "../integrations/email-sender.js";
import { renderInvoice, type RenderableFirm, type RenderedInvoice } from "../core/invoice-render.js";
import { billingEmailFor, type MatterStore } from "../core/matters.js";
import type { AuthService } from "../core/auth.js";

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
  #email: EmailSender | undefined;
  #matters: MatterStore | undefined;
  #auth: AuthService | undefined;
  #firm: RenderableFirm;

  constructor(params: {
    store: InvoiceStore;
    accessControl: AccessControl;
    auditLog: AuditLog;
    trust: TrustLedger;
    billingHours: BillingHoursStore;
    processor: PaymentProcessor;
    /** Absent means the Invoices panel offers download-and-send-yourself instead of an Email button. */
    email?: EmailSender;
    /** Supplies the matter caption and the client's address; absent means the caller must pass `to` explicitly. */
    matters?: MatterStore;
    /** Turns a timekeeper's actorId into a name on the invoice. */
    auth?: AuthService;
    firm?: RenderableFirm;
  }) {
    this.#store = params.store;
    this.#accessControl = params.accessControl;
    this.#auditLog = params.auditLog;
    this.#trust = params.trust;
    this.#billingHours = params.billingHours;
    this.#processor = params.processor;
    this.#email = params.email;
    this.#matters = params.matters;
    this.#auth = params.auth;
    this.#firm = params.firm ?? { name: "This Firm" };
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
    const all = this.#billingHours.listByMatter(matterId);
    if (all.length === 0) throw new InvoicingError(`no logged billable hours on matter '${matterId}'`);

    // Hours already billed on another live invoice are skipped rather
    // than silently added again. Double-billing a client is a fee
    // violation, and "remember not to press the button twice" is not a
    // control. Voiding an invoice releases its hours back.
    const alreadyBilled = this.#store.billedEntryIds(matterId);
    const entries = all
      .filter((e) => !alreadyBilled.has(e.id))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (entries.length === 0) {
      throw new InvoicingError(
        `every logged hour on matter '${matterId}' is already on an invoice — void the earlier invoice if you meant to re-bill it`,
      );
    }

    for (const entry of entries) {
      this.#store.addLineItem(invoice.id, {
        // The date and timekeeper travel as their own fields rather than
        // being mashed into the description, so the rendered invoice can
        // put them in their own columns.
        description: entry.description,
        source: "time",
        quantityMilli: Math.round(entry.hours * 1000),
        unitAmountCents: hourlyRateCents,
        workedOn: entry.date,
        timekeeperId: entry.actorId,
        sourceEntryId: entry.id,
      });
    }
    this.#audit(
      actor,
      matterId,
      "invoice_time_added",
      `invoice=${invoice.number} entries=${entries.length} skippedAlreadyBilled=${all.length - entries.length}`,
    );
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

  /** Whether mail is wired up, so the panel can offer "Email to client" or say why it can't. */
  emailInfo(actor: Actor): { name: string; canSend: boolean; fromAddress: string } {
    requireLegalStaff(actor);
    return {
      name: this.#email?.name ?? "unconfigured",
      canSend: this.#email?.canSend ?? false,
      fromAddress: this.#email?.fromAddress ?? "",
    };
  }

  /**
   * The client-facing document, exactly as it would be emailed. Backs
   * the panel's preview so an attorney reads the real thing before
   * sending it — not an approximation of it.
   */
  preview(actor: Actor, matterId: string, invoiceId: string): RenderedInvoice & { suggestedTo: string | undefined } {
    requireLegalStaff(actor);
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    return { ...this.#render(invoice), suggestedTo: this.#clientEmail(matterId) };
  }

  /**
   * Emails the invoice to the client, sending it first if it's still a
   * draft.
   *
   * **Ordering matters here.** The mail goes out *before* `send()` locks
   * the line items, so a transport failure leaves an editable draft
   * rather than an invoice permanently marked as issued that the client
   * never received — the same reasoning as `payFromTrust` attempting the
   * trust side first. The conditions `send()` would reject on are
   * checked up front so the two can't disagree about whether the invoice
   * was fit to issue.
   *
   * Attorney-only, because this *is* sending a bill to a client, which
   * is the supervisory act `send()` is already gated on.
   */
  async emailInvoice(actor: Actor, matterId: string, invoiceId: string, to?: string): Promise<InvoiceView> {
    requireLegalStaff(actor);
    if (actor.role !== "attorney") {
      throw new AccessDeniedError("emailing an invoice to a client is attorney-only — a paralegal can prepare the draft");
    }
    this.#accessControl.authorize({ actor, matterId, category: "billing_internal" });
    if (!this.#email?.canSend) {
      throw new InvoicingError(
        "no email transport is configured — preview the invoice and send it from your own mail client instead",
      );
    }
    const invoice = this.#requireOnMatter(matterId, invoiceId);
    if (invoice.status === "void") throw new InvoicingError(`invoice ${invoice.number} is void`);
    if (invoice.lineItems.length === 0) throw new InvoicingError("refusing to send an invoice with no line items");

    // Rethrown as an InvoicingError so a bad address is a 400 rather than
    // an unhandled 500 — this is user input, not an internal fault.
    let recipient: string;
    try {
      recipient = assertSafeEmailAddress(
        to ??
          this.#clientEmail(matterId) ??
          "",
      );
    } catch (err) {
      throw new InvoicingError(
        to
          ? (err as Error).message
          : `no client email is on record for matter '${matterId}' — add one to the client party on the Conflicts panel, or type an address here`,
      );
    }
    // Rendered as *issued*, even though the status transition happens
    // below: the copy in the client's inbox must not say "draft — not
    // yet issued". Only the date is printed, so the sub-second gap
    // between this stamp and the one `send()` records is invisible.
    const rendered = this.#render(
      invoice.sentAt ? invoice : { ...invoice, sentAt: new Date().toISOString() },
    );
    const result = await this.#email.send({
      to: recipient,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    // Only now is the invoice committed as issued.
    if (invoice.status === "draft") this.#store.send(invoice.id);
    this.#store.recordDelivery(invoice.id, {
      to: recipient,
      by: actor.id,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    });
    this.#audit(
      actor,
      matterId,
      "invoice_emailed",
      `invoice=${invoice.number} to=${recipient} totalCents=${this.#store.subtotal(invoice.id)} messageId=${
        result.messageId ?? "none"
      }`,
    );
    return this.#view(invoice);
  }

  #clientEmail(matterId: string): string | undefined {
    return billingEmailFor(this.#matters?.get(matterId));
  }

  #render(invoice: Invoice): RenderedInvoice {
    const matter = this.#matters?.get(invoice.matterId);
    const names: Record<string, string> = {};
    for (const line of invoice.lineItems) {
      if (!line.timekeeperId || names[line.timekeeperId]) continue;
      const user = this.#auth?.listUsers().find((u) => u.actorId === line.timekeeperId);
      if (user) names[line.timekeeperId] = user.displayName;
    }
    return renderInvoice({
      invoice,
      totals: this.#store.totals(invoice.id),
      payments: this.#store.paymentsFor(invoice.id),
      firm: this.#firm,
      timekeeperNames: names,
      ...(matter?.title ? { matterTitle: matter.title } : {}),
      ...(matter?.parties.find((party) => party.role === "client")?.name
        ? { clientName: matter.parties.find((party) => party.role === "client")!.name }
        : {}),
    });
  }

  #view(invoice: Invoice): InvoiceView {
    return {
      ...invoice,
      lineItems: invoice.lineItems.map((l) => ({ ...l })),
      deliveries: invoice.deliveries.map((d) => ({ ...d })),
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
