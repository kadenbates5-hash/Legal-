import { Router, newIntakeState, type IntakeState } from "../core/router.js";
import type { EscalationSignals, RouteDirective } from "../core/escalation.js";
import { disclosurePolicyFor } from "../core/confidentiality.js";
import { extractSignalsFromText, extractCandidatePartyNames, parseHoursUntil } from "./signal-extraction.js";
import { BILLING_HANDOFF_SCRIPT, CALLER_TYPE_QUESTION, DIRECTIVE_SCRIPTS, OUTRO_CLEARED_FOR_INTAKE, RECORDING_CONSENT_REFUSED_SCRIPT, WRAP_UP, greetingFor, recordingConsentScriptFor } from "./scripts.js";
import { RECORDING_CONSENT_REFUSAL_RE } from "./signal-extraction.js";
import type { IntakeQuestion, PracticeAreaModule } from "../config/practice-area.js";
import type { Actor } from "../core/types.js";
import type { UtilizationTracker } from "../core/utilization.js";
import type { ConflictChecker } from "../core/conflicts.js";
import { isWithinBusinessHours, type FirmConfig } from "../config/firm-config.js";

/**
 * Chat-channel receptionist agent (§8 build order: "receptionist agent,
 * chat channel first, voice second"). This is the conversational layer —
 * it owns no escalation or access-control logic itself, it only calls into
 * `router.ts`/`escalation.ts` and renders the resulting directive as a
 * scripted reply. Voice would be the same state machine behind a
 * speech-to-text/text-to-speech shim.
 */
/**
 * What just happened on a turn, for a trainer/reviewer watching the
 * conversation (the dashboard's "Live Intake Demo" panel) — purely
 * observational, never consulted by any routing decision. `triggers`
 * mirrors `core/escalation.ts`'s `EscalationTrigger` values as plain
 * strings so this file doesn't need to re-export that union.
 */
export interface TurnTrace {
  label: string;
  triggers: string[];
  state: Readonly<IntakeState>;
}

export interface ChatTurnResult {
  reply: string;
  done: boolean;
  trace: TurnTrace;
  /**
   * True only on an ordinary intake-question turn after the first, where
   * the caller has just answered the previous question. It's the one place
   * a channel may put a short acknowledgement in front of `reply` (see
   * `acknowledgements.ts`); `reply` itself is still the exact script.
   * Never set on an escalation, consent, conflict, handoff, or wrap-up
   * turn, so those are always delivered word for word.
   */
  acknowledgeable?: true;
}

const DIRECTIVE_LABELS: Record<RouteDirective, string> = {
  connect_human_immediately: "Emergency escalation",
  connect_crisis_resources_immediately: "Crisis escalation",
  connect_human_gently: "Vulnerable caller — gentle handoff",
  redirect_no_answer_then_handoff: "Redirected — no legal-advice/narrative answer",
  route_to_human_workflow: "Routed to a human workflow",
  route_interpreter_then_continue: "Interpreter routing",
  hold_for_conflict_check: "Conflict-of-interest check",
  disclose_recording_consent_then_continue: "Recording consent disclosure",
  continue_standard_triage: "Standard triage",
};

type PendingGate = "caller_type" | RouteDirective | "intake_question" | null;

/**
 * Deliberately NOT anchored to the start of the answer. A gating question
 * (in_custody, protective_order_active) is safety-critical, and the same
 * "over-escalating is the safe failure mode" rule from signal-extraction.ts
 * applies here: a self-correction like "No wait, actually yes" must still
 * register as affirmative, not be missed because "yes" isn't the first word.
 */
const AFFIRMATIVE_RE = /(^\s*y\b)|\b(yes|yeah|yep|yup|correct|that's right|affirmative)\b/i;

const NEGATION_RE = /(^\s*(no|nope|nah)\b)|\bnot\b|n't\b/i;
const CUSTODY_WORDS_RE = /\b(arrest|jail|locked up|detain|held)/i;

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
  #conflictChecker: ConflictChecker | undefined;
  #orderedQuestions: IntakeQuestion[];

  #state: IntakeState;
  #pendingGate: PendingGate = "caller_type";
  #intakeQuestionIndex = 0;
  #answers = new Map<string, string>();
  #terminated = false;
  /** Set when an interpreter request preempted the caller-type question before it was answered — see handleMessage. */
  #reaskCallerType = false;
  #firmConfig: FirmConfig | undefined;
  #now: () => Date;

  constructor(params: {
    matterId: string;
    module: PracticeAreaModule;
    router: Router;
    actor: Actor;
    /** Legacy stand-in, kept for tests and for a firm with no matter records yet. Prefer `conflictChecker`. */
    conflictedNames?: string[];
    /** The real firm-wide screen (see core/conflicts.ts). When present it runs *in addition to* conflictedNames — never instead of. */
    conflictChecker?: ConflictChecker;
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
    this.#conflictChecker = params.conflictChecker;
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
      return { reply: WRAP_UP, done: true, trace: { label: "conversation already ended", triggers: [], state: { ...this.#state } } };
    }

    let turnSignals: Partial<EscalationSignals> = extractSignalsFromText(text);

    // Once a caller's free text signals they need an interpreter, that has
    // to become sticky state, not just this turn's raw signal — §2's
    // "language/interpreter is the first triage question" is enforced by
    // `Router.route()` reading `state.interpreterNeeded`, which it folds in
    // *after* `turnSignals` precisely so a one-off mention on an earlier
    // turn isn't forgotten on the next one. Without this line that gate
    // could never actually fire from a caller's own words — only from a
    // value nothing in this class ever set.
    if (turnSignals.interpreterNeeded) {
      this.#state.interpreterNeeded = true;
    }

    if (this.#pendingGate === "caller_type") {
      this.#state.callerType = this.#router.identifyCallerType(detectCallerTypeSignal(text));
      // The interpreter gate preempts this one, so a caller who opens with
      // "I need an interpreter" would otherwise stay "unknown" forever and
      // be treated as a third party at the end of intake.
      if (this.#state.callerType === "unknown" && turnSignals.interpreterNeeded) this.#reaskCallerType = true;
    } else if (this.#pendingGate === "route_interpreter_then_continue") {
      this.#state.interpreterRouted = true;
      if (this.#reaskCallerType) {
        this.#reaskCallerType = false;
        this.#pendingGate = "caller_type";
        return {
          reply: CALLER_TYPE_QUESTION,
          done: false,
          trace: { label: "Caller type question (after interpreter routing)", triggers: [], state: { ...this.#state } },
        };
      }
    } else if (this.#pendingGate === "disclose_recording_consent_then_continue") {
      if (RECORDING_CONSENT_REFUSAL_RE.test(text)) {
        return this.#finish(RECORDING_CONSENT_REFUSED_SCRIPT, "Recording consent refused — handed to a human");
      }
      // An interpreter request is not an answer to the consent question —
      // the router re-asks consent once the language is sorted out.
      if (!turnSignals.interpreterNeeded) this.#state.recordingConsentDisclosed = true;
    } else if (this.#pendingGate === "hold_for_conflict_check") {
      this.#state.conflictCheckRun = true;
      const lowered = text.toLowerCase();
      // Two screens, OR'd together — never one instead of the other. The
      // literal list is a firm-supplied override; the checker is the real
      // firm-wide screen over recorded matter parties (ABA Rule 1.10
      // imputes a conflict across the whole firm). A caller naming an
      // adverse party in an open matter must stop here, which is exactly
      // what the old substring-only check would miss.
      const listHit = this.#conflictedNames.some((name) => lowered.includes(name));
      const candidateNames = extractCandidatePartyNames(text);
      const checkerHit =
        this.#conflictChecker?.check({
          names: candidateNames,
          // At this gate we can't tell from free text which side a named
          // person is on, so every candidate is screened as *adverse* —
          // the reading that actually stops an intake. Screening them as
          // "client" instead would only ever produce same-side or
          // informational hits, which by design don't block, so a real
          // Rule 1.7 conflict would sail straight through. Over-flagging
          // here costs an attorney a glance; under-flagging is the
          // malpractice case.
          roleByName: Object.fromEntries(candidateNames.map((n) => [n, "adverse" as const])),
        }).requiresAttorneyReview ?? false;
      const conflict = listHit || checkerHit;
      this.#state.conflictCheckResolved = !conflict;
      if (conflict) {
        return this.#finish(
          "There may be a conflict of interest here — I'm connecting you with an attorney to review before we go any further.",
          "Conflict of interest detected — handed to an attorney",
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
    const trace: TurnTrace = {
      label: DIRECTIVE_LABELS[decision.directive],
      triggers: decision.escalation.triggers,
      state: { ...this.#state },
    };

    if (
      decision.directive === "connect_human_immediately" ||
      decision.directive === "connect_crisis_resources_immediately" ||
      decision.directive === "connect_human_gently" ||
      decision.directive === "redirect_no_answer_then_handoff" ||
      decision.directive === "route_to_human_workflow"
    ) {
      return this.#finish(DIRECTIVE_SCRIPTS[decision.directive], trace.label, trace.triggers);
    }

    if (!decision.clearedForSubstantiveIntake) {
      this.#pendingGate = decision.directive;
      const reply =
        decision.directive === "disclose_recording_consent_then_continue"
          ? recordingConsentScriptFor(this.#firmConfig)
          : DIRECTIVE_SCRIPTS[decision.directive];
      return { reply, done: false, trace };
    }

    if (this.#state.callerType === "billing") {
      return this.#finish(BILLING_HANDOFF_SCRIPT, "Billing caller — handed to the billing team");
    }

    const disclosure = disclosurePolicyFor(this.#state.callerType);
    if (!disclosure.mayShareCaseDetails) {
      return this.#finish(
        `${disclosure.scriptedResponse} What message would you like me to pass along?`,
        "Third-party caller — message only, no case details shared",
      );
    }

    return this.#askNextIntakeQuestion(trace);
  }

  #askNextIntakeQuestion(trace: TurnTrace): ChatTurnResult {
    const question = this.#orderedQuestions[this.#intakeQuestionIndex];
    if (!question) {
      return this.#finish(WRAP_UP, "Intake complete");
    }
    this.#pendingGate = "intake_question";
    const first = this.#intakeQuestionIndex === 0;
    const prefix = first ? `${OUTRO_CLEARED_FOR_INTAKE} ` : "";
    return {
      reply: `${prefix}${question.prompt}`,
      done: false,
      trace: { ...trace, label: `Intake question: ${question.id}` },
      // The first question already opens with the scripted outro.
      ...(first ? {} : { acknowledgeable: true as const }),
    };
  }

  #finish(reply: string, label: string, triggers: string[] = []): ChatTurnResult {
    this.#terminated = true;
    this.#pendingGate = null;
    if (this.#utilization && this.#utilizationEntryId) {
      this.#utilization.finish(this.#utilizationEntryId, "completed");
    }
    return { reply, done: true, trace: { label, triggers, state: { ...this.#state } } };
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
      if (AFFIRMATIVE_RE.test(answerText)) return { inCustody: true };
      // An explicit `false` is forwarded only for a plain denial, so it can
      // override the extractor's substring match on "not in custody". A
      // denial that also mentions an arrest/jail ("no, but they arrested me
      // this morning") is left to the extractor, which escalates it.
      return NEGATION_RE.test(answerText) && !CUSTODY_WORDS_RE.test(answerText) ? { inCustody: false } : {};
    }
    if (questionId === "court_date") {
      const hours = parseHoursUntil(answerText);
      return hours !== undefined ? { courtAppearanceWithinHours: hours } : {};
    }
    if (questionId === "protective_order_active") {
      // Never forward `false` here: the extractor only flags a protective
      // order together with violation/arrest wording, so a plain "no, there's
      // no protective order" is not a false positive, while "no, but he
      // violated the order and police came" is a real one that a forwarded
      // `false` would suppress.
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
