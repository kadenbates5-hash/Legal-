import type { Invoice, InvoiceLineItem, InvoiceTotals, Payment } from "./invoicing.js";

/**
 * Renders an invoice as the document a client actually receives.
 *
 * The point of this file is the **itemisation**. A bill that says
 * "professional services — $4,250" is the single most common source of
 * fee disputes and fee-arbitration complaints there is, and in many
 * jurisdictions an unitemised bill isn't collectable. What a client is
 * owed is: the date the work was done, who did it, what it was, how long
 * it took, and at what rate. Every one of those is a field on
 * `InvoiceLineItem`, and all five appear on every time line here.
 *
 * Three sections, because they answer different questions: **services**
 * (time), **expenses** (money the firm laid out and is passing through),
 * and **fees** (flat charges). A client scanning for "why is this so
 * much" is looking for one of the three, and merging them hides which.
 *
 * Rendering is deliberately pure — it takes data and returns strings,
 * touching no store, no access control and no transport. That keeps it
 * testable without a mail server, and means the same output backs the
 * on-screen preview and the emailed copy, so what an attorney approves
 * is character-for-character what the client gets.
 */
export interface RenderableFirm {
  name: string;
  addressLines?: string[];
  email?: string;
  phone?: string;
  /** Free text under the totals — "Payable within 30 days", trust-account notices, and so on. */
  paymentInstructions?: string;
}

export interface RenderInvoiceParams {
  invoice: Invoice;
  totals: InvoiceTotals;
  payments: Payment[];
  firm: RenderableFirm;
  /** Matter caption, e.g. "State v. Ruiz". Falls back to the matter id. */
  matterTitle?: string;
  clientName?: string;
  /** actorId → display name, so a line reads "J. Okafor" rather than "p1". */
  timekeeperNames?: Record<string, string>;
}

export interface RenderedInvoice {
  subject: string;
  text: string;
  html: string;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Thousandths to a plain decimal: 7500 → "7.50", 1000 → "1.00". */
export function formatQuantity(milli: number): string {
  return (milli / 1000).toFixed(2);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SECTIONS: { source: InvoiceLineItem["source"]; heading: string; quantityLabel: string }[] = [
  { source: "time", heading: "Professional services", quantityLabel: "Hours" },
  { source: "expense", heading: "Expenses and disbursements", quantityLabel: "Qty" },
  { source: "flat", heading: "Fixed fees", quantityLabel: "Qty" },
];

const PAYMENT_METHOD_LABEL: Record<Payment["method"], string> = {
  card: "Card",
  ach: "Bank transfer",
  check: "Check",
  cash: "Cash",
  trust_application: "Applied from funds held in trust",
  other: "Payment",
};

function timekeeperLabel(line: InvoiceLineItem, names: Record<string, string>): string {
  if (!line.timekeeperId) return "";
  return names[line.timekeeperId] ?? line.timekeeperId;
}

export function renderInvoice(params: RenderInvoiceParams): RenderedInvoice {
  const { invoice, totals, payments, firm } = params;
  const names = params.timekeeperNames ?? {};
  const matterTitle = params.matterTitle || invoice.matterId;
  const subject = `Invoice ${invoice.number} — ${matterTitle}`;

  /* ---------- plain text ---------- */
  const t: string[] = [];
  t.push(firm.name);
  for (const line of firm.addressLines ?? []) t.push(line);
  if (firm.phone) t.push(firm.phone);
  if (firm.email) t.push(firm.email);
  t.push("");
  t.push(`INVOICE ${invoice.number}`);
  if (params.clientName) t.push(`To:      ${params.clientName}`);
  t.push(`Matter:  ${matterTitle} (${invoice.matterId})`);
  t.push(`Issued:  ${invoice.sentAt ? invoice.sentAt.slice(0, 10) : "draft — not yet issued"}`);
  if (invoice.dueDate) t.push(`Due:     ${invoice.dueDate}`);
  if (invoice.status === "void") t.push(`VOID — ${invoice.voidReason ?? "no reason recorded"}`);
  t.push("");

  for (const section of SECTIONS) {
    const lines = invoice.lineItems.filter((l) => l.source === section.source);
    if (lines.length === 0) continue;
    t.push(section.heading.toUpperCase());
    for (const line of lines) {
      const who = timekeeperLabel(line, names);
      const prefix = [line.workedOn, who].filter(Boolean).join("  ");
      t.push(`  ${prefix ? `${prefix}\n  ` : ""}${line.description}`);
      t.push(
        `    ${formatQuantity(line.quantityMilli)} ${section.quantityLabel.toLowerCase()} @ ${formatCents(
          line.unitAmountCents,
        )}  =  ${formatCents(line.amountCents)}`,
      );
    }
    const sectionTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
    t.push(`  ${section.heading} total: ${formatCents(sectionTotal)}`);
    t.push("");
  }

  t.push(`TOTAL:            ${formatCents(totals.subtotalCents)}`);
  if (payments.length > 0) {
    t.push("");
    t.push("PAYMENTS RECEIVED");
    for (const p of payments) {
      t.push(
        `  ${p.recordedAt.slice(0, 10)}  ${PAYMENT_METHOD_LABEL[p.method]}${
          p.reference ? ` (${p.reference})` : ""
        }  -${formatCents(p.amountCents)}`,
      );
    }
    t.push(`  Paid to date:   ${formatCents(totals.paidCents)}`);
  }
  t.push("");
  t.push(`BALANCE DUE:      ${formatCents(totals.balanceCents)}`);
  if (invoice.note) {
    t.push("");
    t.push(invoice.note);
  }
  if (firm.paymentInstructions) {
    t.push("");
    t.push(firm.paymentInstructions);
  }

  /* ---------- html ---------- */
  const h: string[] = [];
  h.push(
    // Inline styles are the only thing mail clients reliably honour;
    // this is an email body, not a page served under this app's CSP.
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:720px">`,
  );
  h.push(`<h1 style="font-size:18px;margin:0 0 2px">${escapeHtml(firm.name)}</h1>`);
  const contact = [...(firm.addressLines ?? []), firm.phone, firm.email].filter(Boolean) as string[];
  if (contact.length) {
    h.push(`<div style="color:#666;font-size:12px">${contact.map(escapeHtml).join("<br />")}</div>`);
  }
  h.push(`<h2 style="font-size:16px;margin:24px 0 4px">Invoice ${escapeHtml(invoice.number)}</h2>`);
  h.push(`<table style="font-size:13px;border-collapse:collapse;margin-bottom:20px"><tbody>`);
  if (params.clientName) h.push(labelRow("To", params.clientName));
  h.push(labelRow("Matter", `${matterTitle} (${invoice.matterId})`));
  h.push(labelRow("Issued", invoice.sentAt ? invoice.sentAt.slice(0, 10) : "draft — not yet issued"));
  if (invoice.dueDate) h.push(labelRow("Due", invoice.dueDate));
  h.push(`</tbody></table>`);
  if (invoice.status === "void") {
    h.push(
      `<p style="color:#b91c1c;font-weight:600">VOID — ${escapeHtml(invoice.voidReason ?? "no reason recorded")}</p>`,
    );
  }

  for (const section of SECTIONS) {
    const lines = invoice.lineItems.filter((l) => l.source === section.source);
    if (lines.length === 0) continue;
    h.push(`<h3 style="font-size:13px;text-transform:uppercase;color:#666;margin:20px 0 6px">${escapeHtml(section.heading)}</h3>`);
    h.push(`<table style="width:100%;border-collapse:collapse;font-size:13px">`);
    h.push(
      `<thead><tr style="text-align:left;border-bottom:1px solid #ddd;color:#666">
         <th style="padding:4px 8px 4px 0">Date</th>
         <th style="padding:4px 8px 4px 0">By</th>
         <th style="padding:4px 8px 4px 0">Description</th>
         <th style="padding:4px 0;text-align:right">${escapeHtml(section.quantityLabel)}</th>
         <th style="padding:4px 0;text-align:right">Rate</th>
         <th style="padding:4px 0;text-align:right">Amount</th>
       </tr></thead><tbody>`,
    );
    for (const line of lines) {
      h.push(
        `<tr style="border-bottom:1px solid #f0f0f0">
           <td style="padding:6px 8px 6px 0;white-space:nowrap;color:#555">${escapeHtml(line.workedOn ?? "")}</td>
           <td style="padding:6px 8px 6px 0;white-space:nowrap;color:#555">${escapeHtml(timekeeperLabel(line, names))}</td>
           <td style="padding:6px 8px 6px 0">${escapeHtml(line.description)}</td>
           <td style="padding:6px 0;text-align:right">${escapeHtml(formatQuantity(line.quantityMilli))}</td>
           <td style="padding:6px 0;text-align:right">${escapeHtml(formatCents(line.unitAmountCents))}</td>
           <td style="padding:6px 0;text-align:right">${escapeHtml(formatCents(line.amountCents))}</td>
         </tr>`,
      );
    }
    const sectionTotal = lines.reduce((sum, l) => sum + l.amountCents, 0);
    h.push(
      `<tr><td colspan="5" style="padding:6px 8px 6px 0;text-align:right;color:#666">${escapeHtml(
        section.heading,
      )} total</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(
        formatCents(sectionTotal),
      )}</td></tr>`,
    );
    h.push(`</tbody></table>`);
  }

  h.push(`<table style="margin-top:20px;font-size:14px;border-collapse:collapse"><tbody>`);
  h.push(totalRow("Total", formatCents(totals.subtotalCents)));
  if (payments.length > 0) {
    for (const p of payments) {
      h.push(
        totalRow(
          `${p.recordedAt.slice(0, 10)} — ${PAYMENT_METHOD_LABEL[p.method]}${p.reference ? ` (${p.reference})` : ""}`,
          `-${formatCents(p.amountCents)}`,
        ),
      );
    }
  }
  h.push(totalRow("Balance due", formatCents(totals.balanceCents), true));
  h.push(`</tbody></table>`);

  if (invoice.note) h.push(`<p style="font-size:13px;color:#444;margin-top:20px">${escapeHtml(invoice.note)}</p>`);
  if (firm.paymentInstructions) {
    h.push(`<p style="font-size:12px;color:#666;margin-top:16px">${escapeHtml(firm.paymentInstructions)}</p>`);
  }
  h.push(`</div>`);

  return { subject, text: t.join("\n"), html: h.join("\n") };
}

function labelRow(label: string, value: string): string {
  return `<tr><td style="padding:2px 16px 2px 0;color:#666">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(
    value,
  )}</td></tr>`;
}

function totalRow(label: string, value: string, emphasise = false): string {
  const weight = emphasise ? "font-weight:700;border-top:2px solid #111" : "";
  return `<tr><td style="padding:4px 24px 4px 0;text-align:right;${weight}">${escapeHtml(
    label,
  )}</td><td style="padding:4px 0;text-align:right;${weight}">${escapeHtml(value)}</td></tr>`;
}
