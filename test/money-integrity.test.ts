import { describe, expect, it } from "vitest";
import { TrustLedger, TrustAccountingError, type TrustEntryType } from "../src/core/trust-ledger.js";
import { InvoiceStore, type PaymentMethod } from "../src/core/invoicing.js";
import { PayrollStore } from "../src/core/payroll.js";
import { TimeClock } from "../src/core/time-clock.js";

/** Values a careless or hostile caller would send, each once stored as sent. */
describe("the trust ledger records only what it can account for", () => {
  it("refuses an entry type it doesn't know, rather than reading it as money leaving", () => {
    const ledger = new TrustLedger();
    ledger.record({ matterId: "m1", type: "deposit", amountCents: 100000, description: "Retainer", recordedBy: "a1" });
    for (const type of ["Disbursement", "teleport", "reversal", ""]) {
      let caught: unknown;
      try {
        ledger.record({ matterId: "m1", type: type as Exclude<TrustEntryType, "reversal">, amountCents: 100, description: "x", recordedBy: "a1" });
      } catch (err) {
        caught = err;
      }
      expect(caught, type).toBeInstanceOf(TrustAccountingError);
      expect((caught as TrustAccountingError).kind, type).toBe("invalid");
    }
    expect(ledger.balanceForMatter("m1")).toBe(100000);
  });

  it("refuses an amount it couldn't add up to the cent, and an overdraw stays a conflict", () => {
    const ledger = new TrustLedger();
    expect(() => ledger.record({ matterId: "m1", type: "deposit", amountCents: 1e17, description: "x", recordedBy: "a1" })).toThrow(/exactly/);
    let overdraw: unknown;
    try {
      ledger.record({ matterId: "m1", type: "disbursement", amountCents: 100, description: "x", recordedBy: "a1" });
    } catch (err) {
      overdraw = err;
    }
    expect((overdraw as TrustAccountingError).kind).toBe("conflict");
  });
});

describe("payments, pay rates and hours", () => {
  it("refuses a payment method the bill can't name", () => {
    const store = new InvoiceStore();
    const invoice = store.createDraft({ matterId: "m1", issuedBy: "a1" });
    store.addLineItem(invoice.id, { description: "Motion", source: "flat", quantityMilli: 1000, unitAmountCents: 50000 });
    store.send(invoice.id);
    expect(() => store.recordPayment({ invoiceId: invoice.id, amountCents: 100, method: "bitcoin" as PaymentMethod, recordedBy: "a1" })).toThrow(
      /payment method must be/,
    );
    expect(store.recordPayment({ invoiceId: invoice.id, amountCents: 100, method: "check", recordedBy: "a1" }).amountCents).toBe(100);
  });

  it("refuses more than a day's hours in one payroll entry, and a rate it can't hold exactly", () => {
    const payroll = new PayrollStore();
    const base = { actorId: "p1", date: "2026-11-02", description: "Worked", recordedBy: "a1" };
    expect(payroll.recordHours({ ...base, hoursMilli: 24_000 }).hoursMilli).toBe(24_000);
    expect(() => payroll.recordHours({ ...base, hoursMilli: 24_001 })).toThrow(/more than a day/);
    expect(() => payroll.recordHours({ ...base, hoursMilli: 1e12 })).toThrow(/more than a day/);
    expect(() => payroll.setRate({ actorId: "p1", hourlyCents: 1e17, effectiveFrom: "2026-01-01", setBy: "a1" })).toThrow(/exactly/);
  });

  it("refuses a timesheet correction that corrects nothing", () => {
    const clock = new TimeClock();
    clock.clockIn("p1");
    const shift = clock.clockOut("p1");
    expect(() => clock.adjust(shift.id, { by: "a1", reason: "fix" })).toThrow(/corrected clock-in or clock-out/);
    expect(shift.corrections).toHaveLength(0);
  });
});
