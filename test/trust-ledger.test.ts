import { describe, expect, it } from "vitest";
import { TrustAccountingError, TrustLedger, formatCents } from "../src/core/trust-ledger.js";

function ledgerWithRetainer(amountCents = 500_00) {
  const ledger = new TrustLedger();
  ledger.record({
    matterId: "m-1",
    type: "deposit",
    amountCents,
    description: "Initial retainer",
    recordedBy: "a1",
  });
  return ledger;
}

describe("TrustLedger — the no-overdraw invariant", () => {
  it("refuses a disbursement that would take a matter below zero", () => {
    const ledger = ledgerWithRetainer(100_00);
    expect(() =>
      ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 100_01, description: "Filing fee", recordedBy: "a1" }),
    ).toThrow(TrustAccountingError);
    // And the failed attempt left nothing behind.
    expect(ledger.balanceForMatter("m-1")).toBe(100_00);
    expect(ledger.listForMatter("m-1")).toHaveLength(1);
  });

  it("names the real reason in the error, not just 'invalid'", () => {
    const ledger = ledgerWithRetainer(100);
    expect(() =>
      ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 200, description: "x", recordedBy: "a1" }),
    ).toThrow(/one client's funds are covering another/i);
  });

  it("refuses to spend from a matter that has never held funds", () => {
    const ledger = new TrustLedger();
    expect(() =>
      ledger.record({ matterId: "m-empty", type: "disbursement", amountCents: 1, description: "x", recordedBy: "a1" }),
    ).toThrow(TrustAccountingError);
  });

  it("allows spending down to exactly zero", () => {
    const ledger = ledgerWithRetainer(250_00);
    const entry = ledger.record({
      matterId: "m-1",
      type: "earned_fee_transfer",
      amountCents: 250_00,
      description: "Fees earned through July",
      recordedBy: "a1",
    });
    expect(entry.balanceAfterCents).toBe(0);
  });

  it("keeps matters isolated — one client's surplus can't fund another's disbursement", () => {
    const ledger = ledgerWithRetainer(1000_00);
    expect(() =>
      ledger.record({ matterId: "m-2", type: "disbursement", amountCents: 1_00, description: "x", recordedBy: "a1" }),
    ).toThrow(TrustAccountingError);
  });
});

describe("TrustLedger — money handling", () => {
  it("rejects fractional cents, which would never reconcile", () => {
    const ledger = new TrustLedger();
    expect(() =>
      ledger.record({ matterId: "m-1", type: "deposit", amountCents: 10.5, description: "x", recordedBy: "a1" }),
    ).toThrow(/integer/i);
  });

  it("rejects zero and negative amounts — direction comes from the type", () => {
    const ledger = new TrustLedger();
    for (const amountCents of [0, -100]) {
      expect(() =>
        ledger.record({ matterId: "m-1", type: "deposit", amountCents, description: "x", recordedBy: "a1" }),
      ).toThrow(/positive/i);
    }
  });

  it("requires a description, since an unexplained movement of client funds is a finding", () => {
    const ledger = new TrustLedger();
    expect(() =>
      ledger.record({ matterId: "m-1", type: "deposit", amountCents: 100, description: "   ", recordedBy: "a1" }),
    ).toThrow(/description/i);
  });

  it("tracks a running balance across a realistic sequence", () => {
    const ledger = ledgerWithRetainer(500_00);
    ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 43_50, description: "Filing fee", recordedBy: "a1" });
    ledger.record({ matterId: "m-1", type: "earned_fee_transfer", amountCents: 200_00, description: "July fees", recordedBy: "a1" });
    ledger.record({ matterId: "m-1", type: "deposit", amountCents: 100_00, description: "Top-up", recordedBy: "a1" });
    expect(ledger.balanceForMatter("m-1")).toBe(356_50);
    expect(ledger.listForMatter("m-1").map((e) => e.balanceAfterCents)).toEqual([500_00, 456_50, 256_50, 356_50]);
  });
});

describe("TrustLedger — immutability and corrections", () => {
  it("corrects a mistake with a reversing entry, leaving both visible", () => {
    const ledger = ledgerWithRetainer(500_00);
    const mistake = ledger.record({
      matterId: "m-1",
      type: "disbursement",
      amountCents: 50_00,
      description: "Wrong payee",
      recordedBy: "a1",
    });
    const reversal = ledger.reverse(mistake.id, "a1", "paid the wrong vendor");
    expect(ledger.balanceForMatter("m-1")).toBe(500_00);
    // History keeps the mistake *and* the correction.
    expect(ledger.listForMatter("m-1")).toHaveLength(3);
    expect(reversal.reversalOf).toBe(mistake.id);
    expect(reversal.description).toMatch(/wrong vendor/);
  });

  it("does not let the same entry be reversed twice", () => {
    const ledger = ledgerWithRetainer();
    const entry = ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 10_00, description: "x", recordedBy: "a1" });
    ledger.reverse(entry.id, "a1", "oops");
    expect(() => ledger.reverse(entry.id, "a1", "again")).toThrow(/already been reversed/i);
  });

  it("refuses to reverse a reversal", () => {
    const ledger = ledgerWithRetainer();
    const entry = ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 10_00, description: "x", recordedBy: "a1" });
    const reversal = ledger.reverse(entry.id, "a1", "oops");
    expect(() => ledger.reverse(reversal.id, "a1", "no")).toThrow(/cannot itself be reversed/i);
  });

  it("applies the no-overdraw rule to reversals too", () => {
    // Deposit, then spend it. Reversing the deposit would imply the matter
    // funded a disbursement it never had money for.
    const ledger = ledgerWithRetainer(100_00);
    const deposit = ledger.listForMatter("m-1")[0]!;
    ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 100_00, description: "spent", recordedBy: "a1" });
    expect(() => ledger.reverse(deposit.id, "a1", "deposit never cleared")).toThrow(TrustAccountingError);
  });

  it("requires a reason for a reversal", () => {
    const ledger = ledgerWithRetainer();
    const entry = ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 1_00, description: "x", recordedBy: "a1" });
    expect(() => ledger.reverse(entry.id, "a1", "  ")).toThrow(/reason/i);
  });

  it("hands out copies and freezes the originals, so recorded history can't be edited in place", () => {
    const ledger = ledgerWithRetainer(500_00);
    // The entry returned at record time is the frozen original.
    const recorded = ledger.record({ matterId: "m-1", type: "deposit", amountCents: 1_00, description: "x", recordedBy: "a1" });
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(() => {
      (recorded as { amountCents: number }).amountCents = 999;
    }).toThrow();

    // And what listAll hands back is a copy, so scribbling on it can't
    // corrupt the ledger even though the copy itself is writable.
    const copy = ledger.listAll()[0]!;
    (copy as { amountCents: number }).amountCents = 999;
    expect(ledger.listAll()[0]!.amountCents).toBe(500_00);
    expect(ledger.balanceForMatter("m-1")).toBe(501_00);
  });
});

describe("TrustLedger — three-way reconciliation", () => {
  it("balances when the bank agrees with the sum of every client sub-ledger", () => {
    const ledger = ledgerWithRetainer(500_00);
    ledger.record({ matterId: "m-2", type: "deposit", amountCents: 250_00, description: "Retainer", recordedBy: "a1" });
    const result = ledger.reconcile(750_00);
    expect(result.balanced).toBe(true);
    expect(result.differenceCents).toBe(0);
    expect(result.perMatter).toEqual([
      { matterId: "m-1", balanceCents: 500_00 },
      { matterId: "m-2", balanceCents: 250_00 },
    ]);
  });

  it("reports the exact shortfall rather than rounding it away", () => {
    const ledger = ledgerWithRetainer(500_00);
    const result = ledger.reconcile(499_99);
    expect(result.balanced).toBe(false);
    expect(result.differenceCents).toBe(-1);
  });

  it("rejects a fractional bank balance", () => {
    expect(() => new TrustLedger().reconcile(10.5)).toThrow(/integer/i);
  });

  it("still lists a matter that has been drawn down to zero", () => {
    const ledger = ledgerWithRetainer(100_00);
    ledger.record({ matterId: "m-1", type: "refund", amountCents: 100_00, description: "Returned unearned", recordedBy: "a1" });
    expect(ledger.reconcile(0).perMatter).toEqual([{ matterId: "m-1", balanceCents: 0 }]);
  });
});

describe("TrustLedger — persistence", () => {
  it("round-trips balances, history and the id counter", () => {
    const ledger = ledgerWithRetainer(500_00);
    ledger.record({ matterId: "m-1", type: "disbursement", amountCents: 43_50, description: "Filing fee", recordedBy: "a1" });

    const restored = TrustLedger.fromSnapshot(ledger.toSnapshot());
    expect(restored.balanceForMatter("m-1")).toBe(456_50);
    expect(restored.listForMatter("m-1")).toHaveLength(2);

    // And a rehydrated ledger still enforces the invariant.
    expect(() =>
      restored.record({ matterId: "m-1", type: "disbursement", amountCents: 1000_00, description: "x", recordedBy: "a1" }),
    ).toThrow(TrustAccountingError);

    const next = restored.record({ matterId: "m-1", type: "deposit", amountCents: 1_00, description: "y", recordedBy: "a1" });
    expect(ledger.listAll().some((e) => e.id === next.id)).toBe(false);
  });
});

describe("formatCents", () => {
  it("renders whole and part dollars without float drift", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(123_45)).toBe("123.45");
    expect(formatCents(-1)).toBe("-0.01");
  });
});
