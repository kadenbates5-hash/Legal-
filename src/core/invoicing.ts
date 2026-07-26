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

export interface InvoiceSnapshot {
  invoices: Invoice[];
  payments: Payment[];
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
}

export class InvoiceStore {
  #invoices = new Map<string, Invoice>();
  #payments: Payment[] = [];
  #nextInvoiceNumber = 1;
  #nextId = 1;

  createDraft(params: { matterId: string; issuedBy: string; dueDate?: string; note?: string }): Invoice {
    const matterId = params.matterId.trim();
    if (!matterId) throw new InvoicingError("matterId is required");
    const invoice: Invoice = {
      id: `inv_${this.#nextId++}`,
      number: `INV-${String(this.#nextInvoiceNumber++).padStart(5, "0")}`,
      matterId,
      status: "draft",
      lineItems: [],
      issuedBy: params.issuedBy,
      createdAt: new Date().toISOString(),
      sentAt: undefined,
      dueDate: params.dueDate,
      voidedAt: undefined,
      voidReason: undefined,
      note: params.note,
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
    if (!Number.isInteger(params.quantityMilli) || params.quantityMilli <= 0) {
      throw new InvoicingError("quantity must be a positive integer number of thousandths");
    }
    assertPositiveCents(params.unitAmountCents, "unit amount");

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

  toSnapshot(): InvoiceSnapshot {
    return {
      invoices: this.listAll().map((i) => ({
        ...i,
        lineItems: i.lineItems.map((l) => ({ ...l })),
        deliveries: i.deliveries.map((d) => ({ ...d })),
      })),
      payments: this.#payments.map((p) => ({ ...p })),
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
    store.#nextInvoiceNumber = snapshot.nextInvoiceNumber ?? store.#invoices.size + 1;
    store.#nextId = snapshot.nextId ?? 1;
    return store;
  }
}
