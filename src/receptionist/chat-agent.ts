import { Router, newIntakeState, type IntakeState } from "../core/router.js";
import type { EscalationSignals, RouteDirective } from "../core/escalation.js";
import { disclosurePolicyFor } from "../core/confidentiality.js";
import { extractSignalsFromText } from "./signal-extraction.js";
import { DIRECTIVE_SCRIPTS, GREETING, OUTRO_CLEARED_FOR_INTAKE, WRAP_UP } from "./scripts.js";
import type { PracticeAreaModule } from "../config/practice-area.js";
import type { Actor, CallerType } from "../core/types.js";
import type { UtilizationTracker } from "../core/utilization.js";

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

const AFFIRMATIVE_RE = /^\s*(y|yes|yeah|yep|correct|that's right)\b/i;

function parseCallerType(text: string): CallerType {
  const t = text.toLowerCase();
  if (/\bfamily|on behalf of|calling for|my (son|daughter|husband|wife|brother|sister|father|mother)\b/.test(t)) {
    return "family_or_third_party";
  }
  if (/\bexisting client|already (a )?client|current client\b/.test(t)) return "existing_client";
  if (/\bbilling|invoice|payment\b/.test(t)) return "billing";
  if (/\bnew client|first time|never (worked with|talked to) you\b/.test(t)) return "new_client";
  return "unknown";
}

export class ReceptionistChatSession {
  #router: Router;
  #module: PracticeAreaModule;
  #actor: Actor;
  #utilization: UtilizationTracker | undefined;
  #utilizationEntryId: string | undefined;
  #conflictedNames: Set<string>;

  #state: IntakeState;
  #pendingGate: PendingGate = "caller_type";
  #intakeQuestionIndex = 0;
  #answers = new Map<string, string>();
  #terminated = false;

  constructor(params: {
    matterId: string;
    module: PracticeAreaModule;
    router: Router;
    actor: Actor;
    conflictedNames?: string[];
    utilization?: UtilizationTracker;
  }) {
    this.#router = params.router;
    this.#module = params.module;
    this.#actor = params.actor;
    this.#utilization = params.utilization;
    this.#conflictedNames = new Set((params.conflictedNames ?? []).map((n) => n.toLowerCase()));
    this.#state = newIntakeState({ matterId: params.matterId, callerType: "unknown" });

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
    return GREETING;
  }

  handleMessage(text: string): ChatTurnResult {
    if (this.#terminated) {
      return { reply: WRAP_UP, done: true };
    }

    let turnSignals: Partial<EscalationSignals> = extractSignalsFromText(text);

    if (this.#pendingGate === "caller_type") {
      this.#state.callerType = parseCallerType(text);
    } else if (this.#pendingGate === "route_interpreter_then_continue") {
      this.#state.interpreterRouted = true;
    } else if (this.#pendingGate === "disclose_recording_consent_then_continue") {
      this.#state.recordingConsentDisclosed = true;
    } else if (this.#pendingGate === "hold_for_conflict_check") {
      this.#state.conflictCheckRun = true;
      const conflict = this.#conflictedNames.has(text.trim().toLowerCase());
      this.#state.conflictCheckResolved = !conflict;
      if (conflict) {
        return this.#finish(
          "There may be a conflict of interest here — I'm connecting you with an attorney to review before we go any further.",
        );
      }
    } else if (this.#pendingGate === "intake_question") {
      const question = this.#module.intakeQuestions[this.#intakeQuestionIndex];
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
      decision.directive === "redirect_no_answer_then_handoff" ||
      decision.directive === "route_to_human_workflow"
    ) {
      return this.#finish(DIRECTIVE_SCRIPTS[decision.directive]);
    }

    if (!decision.clearedForSubstantiveIntake) {
      this.#pendingGate = decision.directive;
      return { reply: DIRECTIVE_SCRIPTS[decision.directive], done: false };
    }

    const disclosure = disclosurePolicyFor(this.#state.callerType);
    if (!disclosure.mayShareCaseDetails) {
      return this.#finish(`${disclosure.scriptedResponse} What message would you like me to pass along?`);
    }

    return this.#askNextIntakeQuestion();
  }

  #askNextIntakeQuestion(): ChatTurnResult {
    const question = this.#module.intakeQuestions[this.#intakeQuestionIndex];
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

  #answerContext(questionId: string, answerText: string): Record<string, unknown> {
    const yes = AFFIRMATIVE_RE.test(answerText);
    if (questionId === "in_custody") return { inCustody: yes };
    return {};
  }

  get state(): Readonly<IntakeState> {
    return this.#state;
  }

  get answers(): ReadonlyMap<string, string> {
    return this.#answers;
  }
}
