import { Router, newIntakeState, type IntakeState } from "../core/router.js";
import type { EscalationSignals, RouteDirective } from "../core/escalation.js";
import { disclosurePolicyFor } from "../core/confidentiality.js";
import { extractSignalsFromText, parseHoursUntil } from "./signal-extraction.js";
import { BILLING_HANDOFF_SCRIPT, DIRECTIVE_SCRIPTS, OUTRO_CLEARED_FOR_INTAKE, RECORDING_CONSENT_REFUSED_SCRIPT, WRAP_UP, greetingFor, recordingConsentScriptFor } from "./scripts.js";
import { RECORDING_CONSENT_REFUSAL_RE } from "./signal-extraction.js";
import type { IntakeQuestion, PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
import type { UtilizationTracker } from "../core/utilization.js";
import { isWithinBusinessHours, type FirmConfig } from "../config/firm-config.js";

/**
 * Chat-channel receptionist agent (§8 build order: "receptionist agent,
 * chat channel first, voice second"). This is the conversational layer —
 * it owns no escalation or access-control logic itself, it only calls into
 * `router.ts`/`escalation.ts` and renders the resulting directive as a
 * scripted reply. Voice would be the same state machine behind a
 * speech-to-text/text-to-speech shim.
 */
export interface ChatTurnResult {
  reply: string;
  done: boolean;
}

type PendingGate = "caller_type" | RouteDirective | "intake_question" | null;

/**
 * Deliberately NOT anchored to the start of the answer. A gating question
 * (in_custody, protective_order_active) is safety-critical, and the same
 * "over-escalating is the safe failure mode" rule from signal-extraction.ts
 * applies here: a self-correction like "No wait, actually yes" must still
 * register as affirmative, not be missed because "yes" isn't the first word.
 */
const AFFIRMATIVE_RE = /(^\s*y\b)|\b(yes|yeah|yep|yup|correct|that's right|affirmative)\b/i;

const CALLER_TYPE_PATTERNS = {
  statesAsFamilyMember: /\bfamily|on behalf of|calling for|my (son|daughter|husband|wife|brother|sister|father|mother)\b/i,
  statesAsExistingClient: /\bexisting client|already (a )?client|current client\b/i,
  statesAsBilling: /\bbilling|invoice|payment\b/i,
  isNewCaller: /\bnew client|first time|never (worked with|talked to) you\b/i,
};

function detectCallerTypeSignal(text: string) {
  return {
    statesAsFamilyMember: CALLER_TYPE_PATTERNS.statesAsFamilyMember.test(text),
    statesAsExistingClient: CALLER_TYPE_PATTERNS.statesAsExistingClient.test(text),
    statesAsBilling: CALLER_TYPE_PATTERNS.statesAsBilling.test(text),
    isNewCaller: CALLER_TYPE_PATTERNS.isNewCaller.test(text),
  };
}

/** Gating questions (safety-critical: custody, court dates) are asked before non-gating ones. */
function orderIntakeQuestions(questions: readonly IntakeQuestion[]): IntakeQuestion[] {
  return [...questions.filter((q) => q.gating), ...questions.filter((q) => !q.gating)];
}

export class ReceptionistChatSession {
  #router: Router;
  #module: PracticeAreaModule;
  #actor: Actor;
  #utilization: UtilizationTracker | undefined;
  #utilizationEntryId: string | undefined;
  #conflictedNames: string[];
  #orderedQuestions: IntakeQuestion[];

  #state: IntakeState;
  #pendingGate: PendingGate = "caller_type";
  #intakeQuestionIndex = 0;
  #answers = new Map<string, string>();
  #terminated = false;
  #firmConfig: FirmConfig | undefined;
  #now: () => Date;

  constructor(params: {
    matterId: string;
    module: PracticeAreaModule;
    router: Router;
    actor: Actor;
    conflictedNames?: string[];
    utilization?: UtilizationTracker;
    /** §1 layer 3: drives greeting branding, after-hours notice, and consent-disclosure wording. Never affects escalation. */
    firmConfig?: FirmConfig;
    /** Injectable clock for testing the after-hours notice deterministically. */
    now?: () => Date;
  }) {
    this.#router = params.router;
    this.#module = params.module;
    this.#actor = params.actor;
    this.#utilization = params.utilization;
    this.#conflictedNames = (params.conflictedNames ?? []).map((n) => n.toLowerCase());
    this.#orderedQuestions = orderIntakeQuestions(params.module.intakeQuestions);
    this.#state = newIntakeState({ matterId: params.matterId, callerType: "unknown" });
    this.#firmConfig = params.firmConfig;
    this.#now = params.now ?? (() => new Date());

    if (this.#utilization) {
      this.#utilizationEntryId = this.#utilization.start({
        matterId: params.matterId,
        agentRole: "receptionist",
        taskType: "intake",
        description: "chat intake session",
      }).id;
    }
  }

  greet(): string {
    const isAfterHours = this.#firmConfig !== undefined && !isWithinBusinessHours(this.#firmConfig, this.#now());
    return greetingFor(this.#firmConfig, isAfterHours);
  }

  handleMessage(text: string): ChatTurnResult {
    if (this.#terminated) {
      return { reply: WRAP_UP, done: true };
    }

    let turnSignals: Partial<EscalationSignals> = extractSignalsFromText(text);

    if (this.#pendingGate === "caller_type") {
      this.#state.callerType = this.#router.identifyCallerType(detectCallerTypeSignal(text));
    } else if (this.#pendingGate === "route_interpreter_then_continue") {
      this.#state.interpreterRouted = true;
    } else if (this.#pendingGate === "disclose_recording_consent_then_continue") {
      if (RECORDING_CONSENT_REFUSAL_RE.test(text)) {
        return this.#finish(RECORDING_CONSENT_REFUSED_SCRIPT);
      }
      this.#state.recordingConsentDisclosed = true;
    } else if (this.#pendingGate === "hold_for_conflict_check") {
      this.#state.conflictCheckRun = true;
      const lowered = text.toLowerCase();
      const conflict = this.#conflictedNames.some((name) => lowered.includes(name));
      this.#state.conflictCheckResolved = !conflict;
      if (conflict) {
        return this.#finish(
          "There may be a conflict of interest here — I'm connecting you with an attorney to review before we go any further.",
        );
      }
    } else if (this.#pendingGate === "intake_question") {
      const question = this.#orderedQuestions[this.#intakeQuestionIndex];
      if (question) {
        this.#answers.set(question.id, text);
        const moduleSignals = this.#module.deriveEscalationSignals(this.#answerContext(question.id, text));
        turnSignals = { ...turnSignals, ...moduleSignals };
        this.#intakeQuestionIndex += 1;
      }
    }

    const decision = this.#router.route(this.#actor, this.#state, turnSignals);

    if (
      decision.directive === "connect_human_immediately" ||
      decision.directive === "connect_crisis_resources_immediately" ||
      decision.directive === "connect_human_gently" ||
      decision.directive === "redirect_no_answer_then_handoff" ||
      decision.directive === "route_to_human_workflow"
    ) {
      return this.#finish(DIRECTIVE_SCRIPTS[decision.directive]);
    }

    if (!decision.clearedForSubstantiveIntake) {
      this.#pendingGate = decision.directive;
      const reply =
        decision.directive === "disclose_recording_consent_then_continue"
          ? recordingConsentScriptFor(this.#firmConfig)
          : DIRECTIVE_SCRIPTS[decision.directive];
      return { reply, done: false };
    }

    if (this.#state.callerType === "billing") {
      return this.#finish(BILLING_HANDOFF_SCRIPT);
    }

    const disclosure = disclosurePolicyFor(this.#state.callerType);
    if (!disclosure.mayShareCaseDetails) {
      return this.#finish(`${disclosure.scriptedResponse} What message would you like me to pass along?`);
    }

    return this.#askNextIntakeQuestion();
  }

  #askNextIntakeQuestion(): ChatTurnResult {
    const question = this.#orderedQuestions[this.#intakeQuestionIndex];
    if (!question) {
      return this.#finish(WRAP_UP);
    }
    this.#pendingGate = "intake_question";
    const prefix = this.#intakeQuestionIndex === 0 ? `${OUTRO_CLEARED_FOR_INTAKE} ` : "";
    return { reply: `${prefix}${question.prompt}`, done: false };
  }

  #finish(reply: string): ChatTurnResult {
    this.#terminated = true;
    this.#pendingGate = null;
    if (this.#utilization && this.#utilizationEntryId) {
      this.#utilization.finish(this.#utilizationEntryId, "completed");
    }
    return { reply, done: true };
  }

  /**
   * Maps a raw intake answer to escalation-relevant context for the
   * practice-area module. `court_date` deliberately doesn't require the
   * word "court" in the answer (unlike the general free-text extractor) —
   * the question itself already establishes the topic, so "yes, tomorrow"
   * must escalate just as reliably as "I have court tomorrow" would.
   */
  #answerContext(questionId: string, answerText: string): Record<string, unknown> {
    if (questionId === "in_custody") {
      return { inCustody: AFFIRMATIVE_RE.test(answerText) };
    }
    if (questionId === "court_date") {
      const hours = parseHoursUntil(answerText);
      return hours !== undefined ? { courtAppearanceWithinHours: hours } : {};
    }
    if (questionId === "protective_order_active") {
      return AFFIRMATIVE_RE.test(answerText) ? { activeProtectiveOrderIssue: true } : {};
    }
    return {};
  }

  get state(): Readonly<IntakeState> {
    return this.#state;
  }

  get answers(): ReadonlyMap<string, string> {
    return this.#answers;
  }
}
