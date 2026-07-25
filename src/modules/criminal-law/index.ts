import type { PracticeAreaModule } from "../../config/practice-area.js";
import type { EscalationSignals } from "../../core/escalation.js";
import type { WorkProduct } from "../../core/review-gate.js";

/**
 * Criminal law practice-area module — the pilot. §7 open item #2: a
 * reasonable seed set covering the core of a typical criminal defense
 * intake and drafting workload, not an exhaustive one, but reviewed and
 * signed off by the practicing attorney overseeing this project as
 * acceptable content for real use — see CLAUDE.md's "§7 open items —
 * status."
 */
export const PADILLA_ADVISORY_FLAG = "padilla_advisory_required";
export const PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG = "protective_order_no_distribution";

export const criminalLawModule: PracticeAreaModule = {
  id: "criminal-law",
  name: "Criminal Law",
  intakeQuestions: [
    // Gating: safety/time-critical — the receptionist chat/voice agent
    // asks these before anything else (see chat-agent.ts's
    // orderIntakeQuestions).
    { id: "in_custody", prompt: "Are you currently in custody?", gating: true },
    { id: "court_date", prompt: "Do you have an upcoming court date?", gating: true },
    {
      id: "protective_order_active",
      prompt: "Is there a protective order, restraining order, or no-contact order related to this case?",
      gating: true,
    },

    // Non-gating: informational, gathered once the safety-critical gates clear.
    { id: "charge_type", prompt: "What are you being charged with, if known?", gating: false },
    { id: "arrest_date", prompt: "When were you arrested, if applicable?", gating: false },
    { id: "bail_status", prompt: "Has bail or bond been set? If so, what amount?", gating: false },
    { id: "arresting_agency", prompt: "Which police department or agency was involved?", gating: false },
    {
      id: "prior_record",
      prompt: "Have you been arrested or charged with a crime before?",
      gating: false,
    },
    {
      id: "co_defendants",
      prompt: "Is anyone else charged in connection with this matter?",
      gating: false,
    },
    {
      id: "immigration_status",
      prompt: "Are you a U.S. citizen? (This affects what your attorney needs to advise you about.)",
      gating: false,
    },
    {
      id: "probation_parole_status",
      prompt: "Are you currently on probation or parole?",
      gating: false,
    },
  ],
  templates: [
    { id: "engagement_letter", name: "Engagement Letter", requiredFlags: [] },
    { id: "discovery_request", name: "Discovery Request", requiredFlags: [] },
    { id: "plea_agreement_memo", name: "Plea Agreement Memo", requiredFlags: [] },
    { id: "motion_to_suppress", name: "Motion to Suppress Evidence", requiredFlags: [] },
    { id: "motion_to_dismiss", name: "Motion to Dismiss", requiredFlags: [] },
    { id: "bail_reduction_motion", name: "Motion for Bail Reduction", requiredFlags: [] },
    { id: "speedy_trial_demand", name: "Speedy Trial Demand", requiredFlags: [] },
    { id: "witness_interview_memo", name: "Witness Interview Memo", requiredFlags: [] },
    { id: "sentencing_memorandum", name: "Sentencing Memorandum", requiredFlags: [] },
    { id: "client_correspondence", name: "Client Correspondence", requiredFlags: [] },
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
  deriveWorkProductFlags(templateId: string, context: Record<string, unknown>): string[] {
    const flags: string[] = [];
    if (templateId === "plea_agreement_memo" && context["clientIsNoncitizen"] === true) {
      flags.push(PADILLA_ADVISORY_FLAG);
    }
    if (context["isProtectiveOrderMaterial"] === true) {
      flags.push(PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG);
    }
    return flags;
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
