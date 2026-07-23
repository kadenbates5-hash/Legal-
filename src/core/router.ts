import { evaluate, type EscalationResult, type EscalationSignals, type RouteDirective } from "./escalation.js";
import { AccessControl } from "./access-control.js";
import type { AuditLog } from "./audit.js";
import type { Actor, CallerType } from "./types.js";

/**
 * §2 receptionist intake sequencing: caller-type identification, then
 * hard-ordered gates — language/interpreter first, conflict check before any
 * substantive info, recording consent disclosed up front — with emergency
 * and other hard-coded triggers able to preempt at any point.
 */
export interface IntakeState {
  matterId: string;
  callerType: CallerType;
  interpreterNeeded: boolean;
  interpreterRouted: boolean;
  recordingConsentRequired: boolean;
  recordingConsentDisclosed: boolean;
  conflictCheckRun: boolean;
  conflictCheckResolved: boolean;
}

export function newIntakeState(params: {
  matterId: string;
  callerType: CallerType;
  interpreterNeeded?: boolean;
  recordingConsentRequired?: boolean;
}): IntakeState {
  return {
    matterId: params.matterId,
    callerType: params.callerType,
    interpreterNeeded: params.interpreterNeeded ?? false,
    interpreterRouted: false,
    recordingConsentRequired: params.recordingConsentRequired ?? true,
    recordingConsentDisclosed: false,
    conflictCheckRun: false,
    conflictCheckResolved: false,
  };
}

export interface RouteDecision {
  directive: RouteDirective;
  reason: string;
  escalation: EscalationResult;
  /** True once every pre-substantive gate has cleared and standard intake fields may be collected. */
  clearedForSubstantiveIntake: boolean;
}

export class Router {
  #accessControl: AccessControl;
  #auditLog: AuditLog;

  constructor(accessControl: AccessControl, auditLog: AuditLog) {
    this.#accessControl = accessControl;
    this.#auditLog = auditLog;
  }

  /**
   * Called once per turn with the latest state and any new signals observed
   * this turn (e.g. "caller just asked whether they're going to jail").
   */
  route(actor: Actor, state: IntakeState, turnSignals: EscalationSignals = {}): RouteDecision {
    const signals: EscalationSignals = {
      ...turnSignals,
      interpreterNeeded: state.interpreterNeeded,
      conflictCheckRun: state.conflictCheckRun,
      conflictCheckResolved: state.conflictCheckResolved,
    };
    const escalation = evaluate(signals);

    this.#auditLog.append({
      actor,
      matterId: state.matterId,
      action: "route_decision",
      detail: `triggers=[${escalation.triggers.join(",")}] priority=${escalation.priority}`,
    });

    // Emergency and hard-alert triggers (legal advice, pre-retention
    // narrative, opt-out) preempt every sequencing gate below.
    if (
      escalation.priority === "emergency" ||
      escalation.directive === "redirect_no_answer_then_handoff" ||
      escalation.directive === "route_to_human_workflow"
    ) {
      return {
        directive: escalation.directive,
        reason: `hard-coded trigger fired: ${escalation.triggers.join(", ")}`,
        escalation,
        clearedForSubstantiveIntake: false,
      };
    }

    // Gate 1: language/interpreter is the first triage question.
    if (state.interpreterNeeded && !state.interpreterRouted) {
      return {
        directive: "route_interpreter_then_continue",
        reason: "interpreter routing must be resolved before any other triage question",
        escalation,
        clearedForSubstantiveIntake: false,
      };
    }

    // Gate 2: recording consent must be disclosed up front.
    if (state.recordingConsentRequired && !state.recordingConsentDisclosed) {
      return {
        directive: "disclose_recording_consent_then_continue",
        reason: "recording consent must be disclosed before proceeding, per applicable state consent rules",
        escalation,
        clearedForSubstantiveIntake: false,
      };
    }

    // Gate 3: conflict-of-interest check before any substantive information is collected.
    if (!state.conflictCheckRun || !state.conflictCheckResolved) {
      return {
        directive: "hold_for_conflict_check",
        reason: "conflict-of-interest check must run and resolve before substantive intake",
        escalation,
        clearedForSubstantiveIntake: false,
      };
    }

    // All gates clear: receptionist may now collect intake/scheduling fields.
    this.#accessControl.authorize({ actor, matterId: state.matterId, category: "intake" });

    return {
      directive: "continue_standard_triage",
      reason: "all pre-substantive gates cleared",
      escalation,
      clearedForSubstantiveIntake: true,
    };
  }

  identifyCallerType(rawSignal: { statesAsExistingClient?: boolean; statesAsFamilyMember?: boolean; statesAsBilling?: boolean; isNewCaller?: boolean }): CallerType {
    if (rawSignal.statesAsExistingClient) return "existing_client";
    if (rawSignal.statesAsFamilyMember) return "family_or_third_party";
    if (rawSignal.statesAsBilling) return "billing";
    if (rawSignal.isNewCaller) return "new_client";
    return "unknown";
  }
}
