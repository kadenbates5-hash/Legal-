import { AccessDeniedError, type Actor } from "../core/types.js";
import type { AccessControl, FieldCategory } from "../core/access-control.js";
import type { WorkProductStore } from "../core/work-product-store.js";
import type { DocumentStore } from "../core/document-store.js";
import type { MatterStore } from "../core/matters.js";
import type { DeadlineTracker } from "../core/deadline.js";
import type { SchedulingService } from "../core/scheduling.js";
import type { InvoiceStore } from "../core/invoicing.js";
import type { TrustLedger } from "../core/trust-ledger.js";
import type { ClientMessageStore } from "../core/client-messages.js";
import type { ESignatureStore } from "../core/esignature.js";

/**
 * One matter's history in one place, on the Cases panel: drafts and their
 * trips through review, uploaded documents, deadlines as they were
 * entered, appointments, invoices and payments, trust movements, client
 * messages and signature requests — newest first, each linking to the
 * panel that owns it.
 *
 * The need is the one every file review starts with: "what's happened on
 * this matter?" Without it the answer meant opening seven panels and
 * putting the dates together by hand.
 *
 * **Nothing here is a new permission.** Each source is read through the
 * same check its own panel makes — `case_file` for drafts, documents,
 * messages and signatures, `billing_internal` for invoices and trust,
 * `scheduling` for appointments (via `SchedulingService`'s own check),
 * and deadlines for an attorney only, as on the Deadlines panel. A source
 * the viewer can't reach is **silently omitted**: no "3 items hidden",
 * which would itself say what exists — the same reasoning as Search.
 * Read-only; it writes nothing but the access checks themselves.
 */
export type TimelineKind =
  | "matter"
  | "work_product"
  | "document"
  | "deadline"
  | "appointment"
  | "invoice"
  | "payment"
  | "trust"
  | "client_message"
  | "signature";

export interface TimelineItem {
  /** ISO timestamp; undefined when the record predates the date being kept. */
  at: string | undefined;
  kind: TimelineKind;
  title: string;
  detail: string | undefined;
  /** The dashboard panel that owns this record, for the item's link. */
  panel: string;
  /** For an appointment, when it's for — sent as a timestamp so the viewer's own time zone shows it. */
  scheduledFor?: string;
}

export interface MatterTimeline {
  matterId: string;
  items: TimelineItem[];
  /** True when older items were left off past `maxItems`. */
  truncated: boolean;
}

const TRANSITION_TITLE: Record<string, string> = {
  pending_review: "submitted for review",
  approved: "approved",
  released: "released",
  revision_requested: "sent back for revision",
  rejected: "rejected",
  draft: "returned to draft",
};

const KIND_LABEL: Record<string, string> = {
  template: "Draft",
  research_summary: "Research summary",
  billing_narrative: "Billing narrative",
  document_report: "Document report",
  risk_assessment: "Risk assessment",
};

const TRUST_LABEL: Record<string, string> = {
  deposit: "Trust deposit",
  disbursement: "Trust disbursement",
  earned_fee_transfer: "Earned fee transferred from trust",
  refund: "Trust refund",
  reversal: "Trust entry reversed",
};

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function snippet(text: string, length = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function humanKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export class MatterTimelineService {
  #accessControl: AccessControl;
  #workProducts: WorkProductStore;
  #documents: DocumentStore;
  #matters: MatterStore | undefined;
  #deadlines: DeadlineTracker | undefined;
  #scheduling: SchedulingService | undefined;
  #invoices: InvoiceStore | undefined;
  #trust: TrustLedger | undefined;
  #clientMessages: ClientMessageStore | undefined;
  #signatures: ESignatureStore | undefined;
  #nameFor: (actorId: string) => string | undefined;

  constructor(params: {
    accessControl: AccessControl;
    workProducts: WorkProductStore;
    documents: DocumentStore;
    matters?: MatterStore;
    deadlines?: DeadlineTracker;
    scheduling?: SchedulingService;
    invoices?: InvoiceStore;
    trust?: TrustLedger;
    clientMessages?: ClientMessageStore;
    signatures?: ESignatureStore;
    /** A person's display name for "by Ada Brooks"; absent, entries just omit who. */
    nameFor?: (actorId: string) => string | undefined;
  }) {
    this.#accessControl = params.accessControl;
    this.#workProducts = params.workProducts;
    this.#documents = params.documents;
    this.#matters = params.matters;
    this.#deadlines = params.deadlines;
    this.#scheduling = params.scheduling;
    this.#invoices = params.invoices;
    this.#trust = params.trust;
    this.#clientMessages = params.clientMessages;
    this.#signatures = params.signatures;
    this.#nameFor = params.nameFor ?? (() => undefined);
  }

  timeline(actor: Actor, matterId: string, options: { maxItems?: number } = {}): MatterTimeline {
    if (actor.role !== "paralegal" && actor.role !== "attorney") {
      throw new AccessDeniedError(`the matter timeline is paralegal/attorney-only (got role '${actor.role}')`);
    }
    // The matter itself: the same check that opens it on the Cases panel.
    // Refused here, the whole request is refused — exactly like the panel.
    this.#accessControl.authorize({ actor, matterId, category: "case_file" });

    const items: TimelineItem[] = [];
    const by = (actorId: string | undefined) => {
      const name = actorId ? this.#nameFor(actorId) : undefined;
      return name ? ` by ${name}` : "";
    };

    // ----- case_file: the matter record, drafts, documents, messages, signatures
    const record = this.#matters?.get(matterId);
    if (record) {
      items.push({ at: record.openedAt, kind: "matter", title: `Matter opened: ${record.title}`, detail: undefined, panel: "conflicts" });
      if (record.closedAt) {
        items.push({ at: record.closedAt, kind: "matter", title: "Matter closed", detail: record.closingNote, panel: "conflicts" });
      }
    }

    for (const wp of this.#workProducts.listByMatter(matterId)) {
      const label = humanKind(wp.kind);
      items.push({ at: wp.createdAt, kind: "work_product", title: `${label} created`, detail: undefined, panel: "drafting" });
      for (const t of wp.history) {
        items.push({
          at: t.timestamp,
          kind: "work_product",
          title: `${label} ${TRANSITION_TITLE[t.to] ?? t.to.replace(/_/g, " ")}${by(t.actor.id)}`,
          detail: t.note,
          panel: actor.role === "attorney" ? "queue" : "drafting",
        });
      }
    }

    for (const doc of this.#documents.listByMatter(matterId)) {
      items.push({
        at: doc.uploadedAt,
        kind: "document",
        title: `Document uploaded: ${doc.fileName}${doc.uploadedByClient ? " (by the client)" : by(doc.uploadedBy)}`,
        detail: undefined,
        panel: "cases",
      });
    }

    for (const message of this.#clientMessages?.listForMatter(matterId) ?? []) {
      items.push({
        at: message.sentAt,
        kind: "client_message",
        title: message.authorRole === "client" ? "Message from the client" : `Message to the client${by(message.authorId)}`,
        detail: snippet(message.body),
        panel: "cases",
      });
    }

    for (const envelope of this.#signatures?.listByMatter(matterId) ?? []) {
      items.push({ at: envelope.createdAt, kind: "signature", title: `Sent for signature: ${envelope.title}`, detail: undefined, panel: "signatures" });
      if (envelope.completedAt) {
        items.push({ at: envelope.completedAt, kind: "signature", title: `Signed by everyone: ${envelope.title}`, detail: undefined, panel: "signatures" });
      }
      if (envelope.voidedAt) {
        items.push({ at: envelope.voidedAt, kind: "signature", title: `Signature request voided: ${envelope.title}`, detail: undefined, panel: "signatures" });
      }
    }

    // ----- deadlines: attorney-only, as on the Deadlines panel
    if (actor.role === "attorney" && this.#deadlines) {
      for (const c of this.#deadlines.toSnapshot().filter((d) => d.matterId === matterId)) {
        items.push({
          at: c.recordedAt,
          kind: "deadline",
          title: `Deadline entered: ${c.type.replace(/_/g, " ")} on ${c.date}`,
          detail: `Source: ${c.source === "agent" ? "calculated by the drafting agent" : c.source === "calendar_system" ? "the firm calendar" : `a person${by(c.recordedBy)}`}`,
          panel: "deadlines",
        });
      }
    }

    // ----- billing_internal: invoices, payments, trust
    if (this.#allowed(actor, matterId, "billing_internal")) {
      for (const invoice of this.#invoices?.listByMatter(matterId) ?? []) {
        items.push({ at: invoice.createdAt, kind: "invoice", title: `Invoice ${invoice.number} drafted`, detail: undefined, panel: "invoices" });
        if (invoice.sentAt) {
          const total = this.#invoices!.totals(invoice.id).subtotalCents;
          items.push({ at: invoice.sentAt, kind: "invoice", title: `Invoice ${invoice.number} issued`, detail: money(total), panel: "invoices" });
        }
        if (invoice.voidedAt) {
          items.push({ at: invoice.voidedAt, kind: "invoice", title: `Invoice ${invoice.number} voided`, detail: invoice.voidReason, panel: "invoices" });
        }
        for (const payment of this.#invoices!.paymentsFor(invoice.id)) {
          items.push({
            at: payment.recordedAt,
            kind: "payment",
            title: `Payment of ${money(payment.amountCents)} on ${invoice.number}`,
            detail: payment.method.replace(/_/g, " "),
            panel: "invoices",
          });
        }
      }
      for (const entry of this.#trust?.listForMatter(matterId) ?? []) {
        items.push({
          at: entry.recordedAt,
          kind: "trust",
          title: `${TRUST_LABEL[entry.type] ?? entry.type}: ${money(entry.amountCents)}`,
          detail: entry.description,
          panel: "trust",
        });
      }
    }

    // ----- appointments: SchedulingService makes its own check, and refuses
    // by throwing for a matter this actor can't reach.
    if (this.#scheduling) {
      let appointments: ReturnType<SchedulingService["listByMatter"]> = [];
      try {
        appointments = this.#scheduling.listByMatter(actor, matterId);
      } catch (err) {
        if (!(err instanceof AccessDeniedError)) throw err;
      }
      for (const appt of appointments) {
        const kind = appt.type === "consultation" ? "Consultation" : "Follow-up";
        const latest = appt.history[appt.history.length - 1];
        for (const h of appt.history) {
          items.push({
            at: h.at,
            kind: "appointment",
            title: `${kind} ${h.status}`,
            detail: h.note,
            panel: "scheduling",
            // The current time belongs on the newest entry only: an older
            // "scheduled" may have been for a time since moved.
            ...(h === latest && h.status !== "cancelled" ? { scheduledFor: appt.startTime } : {}),
          });
        }
      }
    }

    // Newest first; undated records (from before dates were kept) last.
    items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    const maxItems = options.maxItems ?? 500;
    return { matterId, items: items.slice(0, maxItems), truncated: items.length > maxItems };
  }

  #allowed(actor: Actor, matterId: string, category: FieldCategory): boolean {
    try {
      this.#accessControl.authorize({ actor, matterId, category });
      return true;
    } catch (err) {
      if (err instanceof AccessDeniedError) return false;
      throw err;
    }
  }
}
