import { isCalendarDate } from "./calendar-date.js";

/**
 * Client invoicing and payments.
 *
 * Money again, so the same rules as `trust-ledger.ts` apply and for the
 * same reasons: **integer cents everywhere** (a float-rounded invoice
 * total is an argument with a client), and **history that can't be
 * quietly rewritten**.
 *
 * The one rule that matters most here is that an invoice's line items
 * lock the moment it's sent. An invoice a firm can edit after the client
 * has it is not a record of anything — it's the same reasoning that locks
 * `WorkProduct.content` once it reaches review. A sent invoice is
 * corrected by voiding it and issuing a new one, never by editing it.
 *
 * Payments are recorded against an invoice and can never exceed what's
 * outstanding; overpayment is a refund conversation, not something to
 * silently absorb into a negative balance.
 *
 * What this is not: an accounting system, a tax engine, or a dunning
 * process. It records what was billed and what came in.
 */
export class InvoicingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoicingError";
  }
}

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "void";

/**
 * Where a line came from. `time` lines are typically generated from
 * logged billable hours; `expense` is a pass-through cost; `flat` is a
 * fixed fee.
 */
export type LineItemSource = "time" | "expense" | "flat";
const LINE_ITEM_SOURCES: readonly string[] = ["time", "expense", "flat"];

export interface InvoiceLineItem {
  readonly id: string;
  readonly description: string;
  readonly source: LineItemSource;
  /** Hours for `time` lines, unit count otherwise. Thousandths, to allow 0.1h without floats. */
  readonly quantityMilli: number;
  readonly unitAmountCents: number;
  /** quantityMilli * unitAmountCents / 1000, rounded once, at creation. */
  readonly amountCents: number;
  /**
   * The three fields below exist so a rendered invoice can itemise *what
   * was worked on*: the date the work was performed, who performed it,
   * and which timekeeping entry it came from. A client reading "8.5
   * hours — $2,975" has no way to check it; a client reading a dated,
   * attributed line per task does. `workedOn` is deliberately separate
   * from anything on the invoice itself, since an invoice issued in
   * August bills work done in July.
   */
  readonly workedOn: string | undefined;
  readonly timekeeperId: string | undefined;
  /**
   * The `BillingHoursEntry` this line was generated from, if any. Kept
   * so the same logged hour can't be pulled onto a second invoice —
   * double-billing a client is not a mistake to leave to vigilance.
   */
  readonly sourceEntryId: string | undefined;
}

/**
 * How money arrived. `trust_application` is deliberately distinct: it
 * isn't new money, it's the firm applying funds it already held for the
 * client, and it has to be mirrored in the trust ledger — see
 * `review-ui/invoicing-service.ts`.
 */
export type PaymentMethod = "card" | "ach" | "check" | "cash" | "trust_application" | "other";
const PAYMENT_METHODS: readonly string[] = ["card", "ach", "check", "cash", "trust_application", "other"];

export interface Payment {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly method: PaymentMethod;
  /** Processor transaction id, check number, wire reference. */
  readonly reference: string | undefined;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/**
 * Why a copy went out. A reminder is a materially different act from
 * issuing the bill — it is the firm asking for money it is already owed
 * — and a firm that can't tell the two apart can neither show it chased
 * a debt nor notice it has chased the same client six times.
 */
export type DeliveryKind = "invoice" | "reminder";

/** One record of the invoice actually leaving the building. */
export interface InvoiceDelivery {
  readonly kind: DeliveryKind;
  readonly to: string;
  readonly at: string;
  readonly by: string;
  /** The mail transport's own id, so a "did they get it?" question has an answer. */
  readonly messageId: string | undefined;
}

export interface Invoice {
  readonly id: string;
  readonly number: string;
  readonly matterId: string;
  status: InvoiceStatus;
  lineItems: InvoiceLineItem[];
  readonly issuedBy: string;
  readonly createdAt: string;
  sentAt: string | undefined;
  dueDate: string | undefined;
  voidedAt: string | undefined;
  voidReason: string | undefined;
  note: string | undefined;
  /**
   * Where copies of this invoice have been emailed. Append-only, like
   * the audit log and for the same reason: "we sent it on the 3rd" is a
   * claim a firm needs to be able to substantiate.
   */
  deliveries: InvoiceDelivery[];
}

/**
 * Why money a processor took couldn't be applied to the invoice it was
 * for. Each is money the firm holds and Docket would otherwise have no
 * record of.
 */
export type UnappliedReason =
  /** More than the balance left: a check recorded meanwhile, or the client paid from two tabs. */
  | "overpaid"
  /** The invoice was already paid in full by the time the money arrived. */
  | "nothing_owed"
  /** The invoice was voided after the client opened the payment page. */
  | "invoice_void"
  /** No invoice on that matter has the id the payment named. */
  | "invoice_missing";

export const UNAPPLIED_REASONS: readonly UnappliedReason[] = ["overpaid", "nothing_owed", "invoice_void", "invoice_missing"];

/**
 * Money received online that wasn't applied to a bill — kept, rather than
 * dropped, so someone refunds it. Never edited: resolving one records who
 * and what they did, once.
 */
export interface UnappliedReceipt {
  readonly id: string;
  readonly matterId: string;
  readonly invoiceId: string;
  /** The invoice's number when it exists, for a person reading the list. */
  readonly invoiceNumber: string | undefined;
  /** The part not applied to the invoice. */
  readonly amountCents: number;
  /** What the processor reported taking in all, applied part included. */
  readonly receivedCents: number;
  readonly reason: UnappliedReason;
  /** The processor's references, so the refund can be found there. */
  readonly references: readonly string[];
  readonly receivedAt: string;
  readonly resolvedAt: string | undefined;
  readonly resolvedBy: string | undefined;
  readonly resolution: string | undefined;
}

/** How long a resolution note may be — it says what was done with the money, not the whole story. */
export const MAX_RECEIPT_RESOLUTION_LENGTH = 2_000;

export interface InvoiceSnapshot {
  invoices: Invoice[];
  payments: Payment[];
  /** Absent in snapshots written before unapplied receipts existed. */
  unappliedReceipts?: UnappliedReceipt[];
  nextInvoiceNumber: number;
  nextId: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  paidCents: number;
  balanceCents: number;
}

function assertPositiveCents(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new InvoicingError(`${what} must be an integer number of cents`);
  if (value <= 0) throw new InvoicingError(`${what} must be positive`);
  // Past 2^53 an "integer" stops being exact — 1e16 cents plus a cent is
  // still 1e16 — and a bill that doesn't add up to the cent is worse than
  // one that's refused.
  if (!Number.isSafeInteger(value)) throw new InvoicingError(`${what} must be an amount the ledger can hold exactly`);
}

export class InvoiceStore {
  #invoices = new Map<string, Invoice>();
  #payments: Payment[] = [];
  #unapplied: UnappliedReceipt[] = [];
  #nextInvoiceNumber = 1;
  #nextId = 1;

  createDraft(params: { matterId: string; issuedBy: string; dueDate?: string; note?: string }): Invoice {
    const matterId = params.matterId.trim();
    if (!matterId) throw new InvoicingError("matterId is required");
    // Both are printed on the client's bill. A due date was stored as sent,
    // so "garbage" or "2026-13-45" went on the invoice, and the overdue
    // and aging reports compared it as a string and counted days from it.
    const dueDate = params.dueDate?.trim() || undefined;
    if (dueDate && !isCalendarDate(dueDate)) {
      throw new InvoicingError(`dueDate must be a real date in YYYY-MM-DD form (got '${dueDate}')`);
    }
    const note = params.note?.trim() || undefined;
    if (note && note.length > 2_000) throw new InvoicingError("an invoice note must be at most 2,000 characters");
    const invoice: Invoice = {
      id: `inv_${this.#nextId++}`,
      number: `INV-${String(this.#nextInvoiceNumber++).padStart(5, "0")}`,
      matterId,
      status: "draft",
      lineItems: [],
      issuedBy: params.issuedBy,
      createdAt: new Date().toISOString(),
      sentAt: undefined,
      dueDate,
      voidedAt: undefined,
      voidReason: undefined,
      note,
      deliveries: [],
    };
    this.#invoices.set(invoice.id, invoice);
    return invoice;
  }

  /**
   * Adds a line. Only possible while the invoice is a draft — once it's
   * been sent, the client has a copy, and changing what it says after
   * the fact makes the record worthless.
   */
  addLineItem(
    invoiceId: string,
    params: {
      description: string;
      source: LineItemSource;
      quantityMilli: number;
      unitAmountCents: number;
      workedOn?: string;
      timekeeperId?: string;
      sourceEntryId?: string;
    },
  ): InvoiceLineItem {
    const invoice = this.#require(invoiceId);
    if (invoice.status !== "draft") {
      throw new InvoicingError(
        `invoice ${invoice.number} is '${invoice.status}' — a sent invoice can't be edited. Void it and issue a new one.`,
      );
    }
    if (!params.description.trim()) throw new InvoicingError("every line item needs a description");
    // The bill prints time, expenses and fixed fees under their own
    // headings; a line in any other category was totalled but printed
    // nowhere.
    if (!LINE_ITEM_SOURCES.includes(params.source)) {
      throw new InvoicingError(`a line's category must be time, expense or flat (got '${String(params.source)}')`);
    }
    if (!Number.isSafeInteger(params.quantityMilli) || params.quantityMilli <= 0) {
      throw new InvoicingError("quantity must be a positive integer number of thousandths");
    }
    assertPositiveCents(params.unitAmountCents, "unit amount");
    if (!Number.isSafeInteger(params.quantityMilli * params.unitAmountCents)) {
      throw new InvoicingError("quantity × unit amount must be an amount the ledger can hold exactly");
    }
    // The date the work was done is printed on the client's itemised bill.
    if (params.workedOn !== undefined && !isCalendarDate(params.workedOn)) {
      throw new InvoicingError(`the date worked must be a date in YYYY-MM-DD form (got '${params.workedOn}')`);
    }

    const item: InvoiceLineItem = Object.freeze({
      id: `line_${this.#nextId++}`,
      description: params.description.trim(),
      source: params.source,
      quantityMilli: params.quantityMilli,
      unitAmountCents: params.unitAmountCents,
      // Rounded exactly once, here, so a total is always the sum of what's
      // printed rather than a re-derivation that can drift by a cent.
      amountCents: Math.round((params.quantityMilli * params.unitAmountCents) / 1000),
      workedOn: params.workedOn,
      timekeeperId: params.timekeeperId,
      sourceEntryId: params.sourceEntryId,
    });
    invoice.lineItems.push(item);
    return item;
  }

  removeLineItem(invoiceId: string, lineItemId: string): void {
    const invoice = this.#require(invoiceId);
    if (invoice.status !== "draft") {
      throw new InvoicingError(`invoice ${invoice.number} is '${invoice.status}' — its lines are locked`);
    }
    invoice.lineItems = invoice.lineItems.filter((l) => l.id !== lineItemId);
  }

  send(invoiceId: string): Invoice {
    const invoice = this.#require(invoiceId);
    if (invoice.status !== "draft") throw new InvoicingError(`invoice ${invoice.number} has already been sent`);
    if (invoice.lineItems.length === 0) throw new InvoicingError("refusing to send an invoice with no line items");
    invoice.status = "sent";
    invoice.sentAt = new Date().toISOString();
    return invoice;
  }

  /**
   * Voids an invoice. Allowed from draft or sent, but never once money
   * has been applied — a paid invoice with payments against it has to be
   * refunded, not made to disappear.
   */
  void(invoiceId: string, reason: string): Invoice {
    const invoice = this.#require(invoiceId);
    if (invoice.status === "void") throw new InvoicingError(`invoice ${invoice.number} is already void`);
    if (this.paymentsFor(invoiceId).length > 0) {
      throw new InvoicingError(
        `invoice ${invoice.number} has payments against it — refund them rather than voiding the invoice`,
      );
    }
    if (!reason.trim()) throw new InvoicingError("voiding an invoice needs a reason");
    invoice.status = "void";
    invoice.voidedAt = new Date().toISOString();
    invoice.voidReason = reason.trim();
    return invoice;
  }

  /**
   * Records money against an invoice, refusing anything above the
   * outstanding balance. Overpayment is a refund conversation; silently
   * absorbing it would hide client money the firm now owes back.
   */
  recordPayment(params: {
    invoiceId: string;
    amountCents: number;
    method: PaymentMethod;
    reference?: string;
    recordedBy: string;
  }): Payment {
    const invoice = this.#require(params.invoiceId);
    if (invoice.status === "draft") throw new InvoicingError("send the invoice before recording payment against it");
    if (invoice.status === "void") throw new InvoicingError("cannot pay a voided invoice");
    assertPositiveCents(params.amountCents, "payment amount");
    // Printed on the client's copy as how they paid; an unknown one printed
    // as nothing at all.
    if (!PAYMENT_METHODS.includes(params.method)) {
      throw new InvoicingError(`payment method must be card, ach, check, cash or other (got '${String(params.method)}')`);
    }

    const { balanceCents } = this.totals(invoice.id);
    if (params.amountCents > balanceCents) {
      throw new InvoicingError(
        `payment of ${params.amountCents} cents exceeds the ${balanceCents}-cent balance on ${invoice.number}`,
      );
    }

    const payment: Payment = Object.freeze({
      id: `pay_${this.#nextId++}`,
      invoiceId: invoice.id,
      amountCents: params.amountCents,
      method: params.method,
      reference: params.reference?.trim() || undefined,
      recordedBy: params.recordedBy,
      recordedAt: new Date().toISOString(),
    });
    this.#payments.push(payment);

    const paid = this.totals(invoice.id).paidCents;
    invoice.status = paid >= this.subtotal(invoice.id) ? "paid" : "partially_paid";
    return payment;
  }

  /**
   * Every billing-hours entry id already billed on this matter, across
   * all its invoices except voided ones. A void invoice releases its
   * hours back for re-billing, which is exactly what voiding-and-
   * reissuing is for.
   */
  billedEntryIds(matterId: string): Set<string> {
    const billed = new Set<string>();
    for (const invoice of this.listByMatter(matterId)) {
      if (invoice.status === "void") continue;
      for (const line of invoice.lineItems) {
        if (line.sourceEntryId) billed.add(line.sourceEntryId);
      }
    }
    return billed;
  }

  /** Records that a copy went out. Never gated on status — a receipt for a paid invoice is a legitimate thing to resend. */
  recordDelivery(invoiceId: string, params: { to: string; by: string; messageId?: string; kind?: DeliveryKind }): InvoiceDelivery {
    const invoice = this.#require(invoiceId);
    const delivery: InvoiceDelivery = Object.freeze({
      kind: params.kind ?? "invoice",
      to: params.to,
      at: new Date().toISOString(),
      by: params.by,
      messageId: params.messageId,
    });
    invoice.deliveries.push(delivery);
    return delivery;
  }

  subtotal(invoiceId: string): number {
    return this.#require(invoiceId).lineItems.reduce((sum, l) => sum + l.amountCents, 0);
  }

  totals(invoiceId: string): InvoiceTotals {
    const subtotalCents = this.subtotal(invoiceId);
    const paidCents = this.paymentsFor(invoiceId).reduce((sum, p) => sum + p.amountCents, 0);
    return { subtotalCents, paidCents, balanceCents: subtotalCents - paidCents };
  }

  paymentsFor(invoiceId: string): Payment[] {
    return this.#payments.filter((p) => p.invoiceId === invoiceId).map((p) => ({ ...p }));
  }

  get(invoiceId: string): Invoice | undefined {
    return this.#invoices.get(invoiceId);
  }

  listByMatter(matterId: string): Invoice[] {
    return [...this.#invoices.values()].filter((i) => i.matterId === matterId);
  }

  listAll(): Invoice[] {
    return [...this.#invoices.values()];
  }

  #require(invoiceId: string): Invoice {
    const invoice = this.#invoices.get(invoiceId);
    if (!invoice) throw new InvoicingError(`no invoice '${invoiceId}'`);
    return invoice;
  }

  /**
   * Keeps money that arrived but couldn't go on the invoice it was for.
   * Refuses only what isn't money: a non-positive or inexact amount, or a
   * reason it doesn't know.
   */
  recordUnappliedReceipt(params: {
    matterId: string;
    invoiceId: string;
    amountCents: number;
    receivedCents: number;
    reason: UnappliedReason;
    references: string[];
  }): UnappliedReceipt {
    assertPositiveCents(params.amountCents, "unapplied amount");
    assertPositiveCents(params.receivedCents, "amount received");
    if (params.amountCents > params.receivedCents) throw new InvoicingError("the unapplied part can't exceed what was received");
    if (!UNAPPLIED_REASONS.includes(params.reason)) throw new InvoicingError(`unknown reason '${String(params.reason)}'`);
    const receipt: UnappliedReceipt = Object.freeze({
      id: `rcpt_${this.#nextId++}`,
      matterId: params.matterId,
      invoiceId: params.invoiceId,
      invoiceNumber: this.#invoices.get(params.invoiceId)?.number,
      amountCents: params.amountCents,
      receivedCents: params.receivedCents,
      reason: params.reason,
      references: Object.freeze(params.references.filter((r) => r.trim())),
      receivedAt: new Date().toISOString(),
      resolvedAt: undefined,
      resolvedBy: undefined,
      resolution: undefined,
    });
    this.#unapplied.push(receipt);
    return receipt;
  }

  /** Every unapplied receipt, oldest first. */
  unappliedReceipts(): UnappliedReceipt[] {
    return this.#unapplied.map((r) => ({ ...r }));
  }

  /**
   * Whether a processor reference has already been accounted for, as a
   * payment or as an unapplied receipt — so a retried webhook is a no-op
   * whichever way the first delivery went.
   */
  hasProcessorReference(reference: string): boolean {
    if (!reference) return false;
    return this.#payments.some((p) => p.reference === reference) || this.#unapplied.some((r) => r.references.includes(reference));
  }

  /** Records, once, what was done with an unapplied receipt (refunded, applied elsewhere by agreement…). */
  resolveUnappliedReceipt(id: string, params: { by: string; resolution: string }): UnappliedReceipt {
    const index = this.#unapplied.findIndex((r) => r.id === id);
    if (index === -1) throw new InvoicingError(`no unapplied receipt '${id}'`);
    const current = this.#unapplied[index]!;
    if (current.resolvedAt) throw new InvoicingError(`receipt '${id}' was already resolved`);
    const resolution = (params.resolution ?? "").trim();
    if (!resolution) throw new InvoicingError("a note is required: say what was done with the money — refunded, and the refund's reference");
    if (resolution.length > MAX_RECEIPT_RESOLUTION_LENGTH) {
      throw new InvoicingError(`the note must be at most ${MAX_RECEIPT_RESOLUTION_LENGTH} characters`);
    }
    const resolved: UnappliedReceipt = Object.freeze({ ...current, resolvedAt: new Date().toISOString(), resolvedBy: params.by, resolution });
    this.#unapplied[index] = resolved;
    return { ...resolved };
  }

  toSnapshot(): InvoiceSnapshot {
    return {
      invoices: this.listAll().map((i) => ({
        ...i,
        lineItems: i.lineItems.map((l) => ({ ...l })),
        deliveries: i.deliveries.map((d) => ({ ...d })),
      })),
      payments: this.#payments.map((p) => ({ ...p })),
      unappliedReceipts: this.#unapplied.map((r) => ({ ...r, references: [...r.references] })),
      nextInvoiceNumber: this.#nextInvoiceNumber,
      nextId: this.#nextId,
    };
  }

  static fromSnapshot(snapshot: InvoiceSnapshot): InvoiceStore {
    const store = new InvoiceStore();
    for (const invoice of snapshot.invoices ?? []) {
      store.#invoices.set(invoice.id, {
        ...invoice,
        lineItems: (invoice.lineItems ?? []).map((l) => Object.freeze({ ...l })),
        // Older snapshots predate delivery tracking; an absent list is empty, not broken.
        // Those written before reminders existed were all the invoice itself.
        deliveries: (invoice.deliveries ?? []).map((d) => Object.freeze({ ...d, kind: d.kind ?? "invoice" })),
      });
    }
    store.#payments = (snapshot.payments ?? []).map((p) => Object.freeze({ ...p }));
    store.#unapplied = (snapshot.unappliedReceipts ?? []).map((r) =>
      Object.freeze({ ...r, references: Object.freeze([...(r.references ?? [])]) }),
    );
    store.#nextInvoiceNumber = snapshot.nextInvoiceNumber ?? store.#invoices.size + 1;
    store.#nextId = snapshot.nextId ?? 1;
    return store;
  }
}
