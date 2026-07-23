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

  it("§7 item 2: covers the full criminal-defense intake question set, gating questions marked", () => {
    const ids = criminalLawModule.intakeQuestions.map((q) => q.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "in_custody",
        "court_date",
        "protective_order_active",
        "charge_type",
        "arrest_date",
        "bail_status",
        "arresting_agency",
        "prior_record",
        "co_defendants",
        "immigration_status",
        "probation_parole_status",
      ]),
    );
    const gating = criminalLawModule.intakeQuestions.filter((q) => q.gating).map((q) => q.id);
    expect(gating).toEqual(["in_custody", "court_date", "protective_order_active"]);
  });

  it("§7 item 2: covers a realistic criminal-defense document template set", () => {
    const ids = criminalLawModule.templates.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "engagement_letter",
        "discovery_request",
        "plea_agreement_memo",
        "motion_to_suppress",
        "motion_to_dismiss",
        "bail_reduction_motion",
        "speedy_trial_demand",
        "witness_interview_memo",
        "sentencing_memorandum",
        "client_correspondence",
      ]),
    );
  });
});
