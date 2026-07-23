import { describe, expect, it } from "vitest";
import { criminalLawModule, applyPadillaFlagIfApplicable, PADILLA_ADVISORY_FLAG } from "../src/modules/criminal-law/index.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

describe("criminal law module", () => {
  it("derives core escalation signals from module-specific context without core changes", () => {
    const signals = criminalLawModule.deriveEscalationSignals({ inCustody: true, courtAppearanceWithinHours: 12 });
    expect(signals.inCustody).toBe(true);
    expect(signals.courtAppearanceWithinHours).toBe(12);
  });

  it("hard-triggers the Padilla flag for plea-related drafting for a noncitizen client", () => {
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "plea_agreement_memo", content: "draft" }, new AuditLog());
    applyPadillaFlagIfApplicable(wp, true, true);
    expect(wp.flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);

    wp.submitForReview(paralegal);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);
  });

  it("does not flag plea drafting for a citizen client", () => {
    const wp = new WorkProduct({ id: "wp2", matterId: "m1", kind: "plea_agreement_memo", content: "draft" }, new AuditLog());
    applyPadillaFlagIfApplicable(wp, false, true);
    expect(wp.flags.size).toBe(0);
  });
});
