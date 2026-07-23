import type { EmergencyTrigger, EscalationTrigger, StandardTrigger } from "./types.js";

/**
 * Signals the receptionist agent (or a human reviewing a transcript) can
 * observe during a call/chat. Practice-area modules may add their own
 * signal sources, but they can only ever ADD triggers, never suppress the
 * core ones below — see EscalationEngine.evaluate.
 */
export interface EscalationSignals {
  inCustody?: boolean;
  imminentPoliceQuestioning?: boolean;
  courtAppearanceWithinHours?: number;
  activeProtectiveOrderIssue?: boolean;
  callerAskedForLegalAdvice?: boolean;
  callerNarratingFacts?: boolean;
  conflictCheckResolved?: boolean;
  conflictCheckRun?: boolean;
  vulnerableCaller?: boolean;
  clientRequestedOptOut?: boolean;
  interpreterNeeded?: boolean;
}

export type RoutePriority = "emergency" | "elevated" | "standard";

export interface EscalationResult {
  escalate: boolean;
  priority: RoutePriority;
  triggers: EscalationTrigger[];
  /** What the receptionist agent must do right now. */
  directive: RouteDirective;
}

export type RouteDirective =
  | "connect_human_immediately"
  | "redirect_no_answer_then_handoff"
  | "route_to_human_workflow"
  | "route_interpreter_then_continue"
  | "hold_for_conflict_check"
  | "disclose_recording_consent_then_continue"
  | "continue_standard_triage";

const COURT_APPEARANCE_ESCALATION_WINDOW_HOURS = 48;

/**
 * Pure, hard-coded rule evaluation for §2's "Hard-coded behaviors (no
 * exceptions)". This function has no config knob to weaken any of these
 * triggers — that's deliberate. A practice-area module can call
 * `evaluate` and then layer additional triggers on top via
 * `withAdditionalTriggers`, but it cannot remove or downgrade a core one.
 */
export function evaluate(signals: EscalationSignals): EscalationResult {
  const emergencyTriggers: EmergencyTrigger[] = [];
  const standardTriggers: StandardTrigger[] = [];

  if (signals.inCustody) emergencyTriggers.push("in_custody");
  if (signals.imminentPoliceQuestioning) emergencyTriggers.push("imminent_police_questioning");
  if (
    signals.courtAppearanceWithinHours !== undefined &&
    signals.courtAppearanceWithinHours <= COURT_APPEARANCE_ESCALATION_WINDOW_HOURS
  ) {
    emergencyTriggers.push("court_appearance_imminent");
  }
  if (signals.activeProtectiveOrderIssue) emergencyTriggers.push("active_protective_order");

  if (signals.callerAskedForLegalAdvice) standardTriggers.push("legal_advice_requested");
  if (signals.callerNarratingFacts) standardTriggers.push("pre_retention_factual_narrative");
  if (signals.conflictCheckRun && !signals.conflictCheckResolved) {
    standardTriggers.push("conflict_of_interest_unresolved");
  }
  if (signals.vulnerableCaller) standardTriggers.push("vulnerable_caller");
  if (signals.clientRequestedOptOut) standardTriggers.push("client_opt_out");
  if (signals.interpreterNeeded) standardTriggers.push("interpreter_required");

  const triggers: EscalationTrigger[] = [...emergencyTriggers, ...standardTriggers];

  if (emergencyTriggers.length > 0) {
    return {
      escalate: true,
      priority: "emergency",
      triggers,
      directive: "connect_human_immediately",
    };
  }

  if (standardTriggers.includes("legal_advice_requested") || standardTriggers.includes("pre_retention_factual_narrative")) {
    return {
      escalate: true,
      priority: "elevated",
      triggers,
      directive: "redirect_no_answer_then_handoff",
    };
  }

  if (standardTriggers.includes("client_opt_out")) {
    return {
      escalate: true,
      priority: "elevated",
      triggers,
      directive: "route_to_human_workflow",
    };
  }

  // conflict_of_interest_unresolved and interpreter_required are detected
  // here (and included in `triggers` for audit purposes) but their directive
  // is resolved by the router's intake-sequencing gates instead of here —
  // see router.ts. They're procedural sequencing steps, not alert triggers.

  if (standardTriggers.includes("vulnerable_caller")) {
    return {
      escalate: true,
      priority: "elevated",
      triggers,
      directive: "redirect_no_answer_then_handoff",
    };
  }

  return {
    escalate: false,
    priority: "standard",
    triggers,
    directive: "continue_standard_triage",
  };
}
