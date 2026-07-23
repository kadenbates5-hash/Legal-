import type { PracticeAreaModule } from "../../config/practice-area.js";
import type { EscalationSignals } from "../../core/escalation.js";
import type { WorkProduct } from "../../core/review-gate.js";

/**
 * Criminal law practice-area module — the pilot. §7 flags full intake
 * question sets and templates as an open item to design separately; this
 * seeds the minimal set needed to prove the module plugs into core without
 * modifying it.
 */
export const PADILLA_ADVISORY_FLAG = "padilla_advisory_required";
export const PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG = "protective_order_no_distribution";

export const criminalLawModule: PracticeAreaModule = {
  id: "criminal-law",
  name: "Criminal Law",
  intakeQuestions: [
    { id: "charge_type", prompt: "What are you being charged with, if known?", gating: false },
    { id: "in_custody", prompt: "Are you currently in custody?", gating: true },
    { id: "court_date", prompt: "Do you have an upcoming court date?", gating: true },
  ],
  templates: [
    { id: "engagement_letter", name: "Engagement Letter", requiredFlags: [] },
    { id: "discovery_request", name: "Discovery Request", requiredFlags: [] },
    { id: "plea_agreement_memo", name: "Plea Agreement Memo", requiredFlags: [] },
  ],
  deriveEscalationSignals(context: Record<string, unknown>): Partial<EscalationSignals> {
    const signals: Partial<EscalationSignals> = {};
    if (context["inCustody"] === true) signals.inCustody = true;
    if (context["policeQuestioningImminent"] === true) signals.imminentPoliceQuestioning = true;
    if (typeof context["courtAppearanceWithinHours"] === "number") {
      signals.courtAppearanceWithinHours = context["courtAppearanceWithinHours"] as number;
    }
    if (context["activeProtectiveOrderIssue"] === true) signals.activeProtectiveOrderIssue = true;
    return signals;
  },
};

/**
 * §3 Padilla flag: "any plea-related drafting for a noncitizen client must
 * hard-trigger an immigration-consequence advisory flag for attorney
 * review ... not rely on someone remembering to check." Called whenever a
 * plea-related work product is created or edited for this module.
 */
export function applyPadillaFlagIfApplicable(workProduct: WorkProduct, clientIsNoncitizen: boolean, isPleaRelated: boolean): void {
  if (clientIsNoncitizen && isPleaRelated) {
    workProduct.addFlag(PADILLA_ADVISORY_FLAG);
  }
}

/** §3 protective-order/discovery handling: metadata tag checked before any drafting/copying/sharing action. */
export function applyProtectiveOrderFlagIfApplicable(workProduct: WorkProduct, isProtectiveOrderMaterial: boolean): void {
  if (isProtectiveOrderMaterial) {
    workProduct.addFlag(PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG);
  }
}
