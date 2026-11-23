import { Router, newIntakeState, type IntakeState } from "../core/router.js";
import type { EscalationSignals, RouteDirective } from "../core/escalation.js";
import { disclosurePolicyFor } from "../core/confidentiality.js";
import { extractSignalsFromText, extractCandidatePartyNames, normalizeCallerText, parseHoursUntil } from "./signal-extraction.js";
import {
  BILLING_HANDOFF_SCRIPT,
  CALLER_TYPE_CLARIFY_QUESTION,
  CALLER_TYPE_QUESTION,
  CONFLICT_REASK_QUESTION,
  CONSENT_CLARIFY_QUESTION,
  CONSENT_REASK_QUESTION,
  DIRECTIVE_SCRIPTS,
  OUTRO_CLEARED_FOR_INTAKE,
  RECORDING_CONSENT_REFUSED_SCRIPT,
  RECORDING_CONSENT_UNCLEAR_SCRIPT,
  SIDE_QUESTION_HANDOFF_SCRIPT,
  UNIDENTIFIED_CALLER_MESSAGE_SCRIPT,
  WRAP_UP,
  greetingFor,
  recordingConsentScriptFor,
} from "./scripts.js";
import { classifyConsentAnswer, classifySideQuestion, sideAnswerFor, type ConsentAnswer, type QuestionGate } from "./side-questions.js";
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

/**
 * Who the call is about. Third party is checked first by the router (see
 * `identifyCallerType`), so a caller who mentions a relative is never
 * mistaken for the client. The new-client patterns cover how people
 * actually open a call ("I got a DUI and need a lawyer", "it's for me"):
 * only literally saying "new client" used to count, and everyone else was
 * treated as an unidentified caller and offered a message-only brush-off.
 */
const CALLER_TYPE_PATTERNS = {
  statesAsFamilyMember:
    /\b(?:family|on behalf of|calling for|someone else|somebody else|for (?:him|her|them)|a friend|my (?:son|daughter|husband|wife|brother|sister|father|mother|dad|mom|friend|boyfriend|girlfriend|partner|fianc[eé]e?|cousin|uncle|aunt|grandmother|grandfather|grandma|grandpa|nephew|niece|kid|child|client|employee))\b/i,
  statesAsExistingClient: /\b(?:existing client|already (?:a )?client|current client|you(?:'re| are) (?:already )?(?:representing|helping) me|my (?:lawyer|attorney) (?:is|there)|about my (?:case|matter|file))\b/i,
  statesAsBilling: /\b(?:billing|invoice|payment|my bill)\b/i,
  isNewCaller:
    /\b(?:new client|first time|never (?:worked with|talked to) you|i need (?:a |an )?(?:lawyer|attorney|help|representation)|looking for (?:a |an )?(?:lawyer|attorney)|i (?:got|was|have been|'ve been|just got) (?:a |an )?(?:charged|arrested|cited|ticket|dui|dwi|summons|indicted|citation)|i (?:got|have|received) (?:a |an )?(?:dui|dwi|ticket|citation|summons|warrant)|for (?:me|myself)|it'?s (?:for )?me|my own|about me|myself|^\s*me\s*[.!]?\s*$|^\s*mine\s*[.!]?\s*$)/i,
};

/** Consecutive side questions answered before handing the caller to a person, so a call can never circle forever. */
const MAX_SIDE_QUESTIONS = 2;

/** True if any escalation-relevant signal fired — those always take the normal path, never the side-question one. */
function hasEscalationSignal(signals: Partial<EscalationSignals>): boolean {
  return Object.values(signals).some((v) => v === true || typeof v === "number");
}

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
  /** The question the caller was last asked, repeated verbatim after a side answer. */
  #lastQuestion = CALLER_TYPE_QUESTION;
  #sideQuestionsInARow = 0;
  #callerTypeAsks = 0;
  #consentAsks = 0;

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

  handleMessage(rawText: string): ChatTurnResult {
    // One normalization for every check below — the caller-type, consent,
    // custody-answer and conflict matchers all see the same text.
    const text = normalizeCallerText(rawText);
    if (this.#terminated) {
      return { reply: WRAP_UP, done: true, trace: { label: "conversation already ended", triggers: [], state: { ...this.#state } } };
    }

    let turnSignals: Partial<EscalationSignals> = extractSignalsFromText(text, this.#now());

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

    // A question back ("are you a robot?", "sorry, what?") gets a brief
    // answer and the same question again, and nothing advances — otherwise
    // it was taken as the answer and a gating question could be skipped.
    // Only a message with no escalation signal at all can take this path.
    const gate = this.#questionGate();
    if (gate && !hasEscalationSignal(turnSignals)) {
      const kind = classifySideQuestion(text, gate);
      if (kind) {
        this.#sideQuestionsInARow += 1;
        if (this.#sideQuestionsInARow > MAX_SIDE_QUESTIONS) {
          return this.#finish(SIDE_QUESTION_HANDOFF_SCRIPT, "Several questions in a row — handed to a person");
        }
        return {
          reply: `${sideAnswerFor(kind, this.#firmConfig)} ${this.#lastQuestion}`,
          done: false,
          trace: { label: `Side question answered (${kind}) — same question asked again`, triggers: [], state: { ...this.#state } },
        };
      }
    }
    this.#sideQuestionsInARow = 0;

    const answeredGate = this.#pendingGate;
    let consentAnswer: ConsentAnswer | undefined;

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
        this.#lastQuestion = CALLER_TYPE_QUESTION;
        return {
          reply: CALLER_TYPE_QUESTION,
          done: false,
          trace: { label: "Caller type question (after interpreter routing)", triggers: [], state: { ...this.#state } },
        };
      }
    } else if (this.#pendingGate === "disclose_recording_consent_then_continue") {
      // An interpreter request is not an answer to the consent question —
      // the router re-asks consent once the language is sorted out.
      if (!turnSignals.interpreterNeeded) {
        const answer = classifyConsentAnswer(text);
        // One-party consent is notice, not a request: only an explicit
        // refusal stops it. Everywhere else consent takes a yes, so "No."
        // or "what?" is never taken as agreement.
        consentAnswer = this.#firmConfig?.jurisdictionRecordingConsent === "one-party-consent" && answer === "unclear" ? "agree" : answer;
        if (consentAnswer === "agree") this.#state.recordingConsentDisclosed = true;
      }
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

    // Decided after routing, so an emergency in the same message always
    // wins over a refusal or an unclear answer.
    if (consentAnswer === "refuse") {
      return this.#finish(RECORDING_CONSENT_REFUSED_SCRIPT, "Recording consent refused — handed to a human");
    }
    if (consentAnswer === "unclear" && decision.directive === "disclose_recording_consent_then_continue") {
      this.#consentAsks += 1;
      if (this.#consentAsks >= 2) {
        return this.#finish(RECORDING_CONSENT_UNCLEAR_SCRIPT, "Recording consent unclear twice — handed to a person, not recorded");
      }
      this.#lastQuestion = CONSENT_CLARIFY_QUESTION;
      return { reply: CONSENT_CLARIFY_QUESTION, done: false, trace: { ...trace, label: "Recording consent unclear — asked for a yes or no" } };
    }

    // One clarifying re-ask before an unidentified caller is treated as a
    // message-only call. Skipped when an interpreter is needed: the caller
    // type question is re-asked after the language is sorted out instead.
    if (
      answeredGate === "caller_type" &&
      this.#state.callerType === "unknown" &&
      !this.#state.interpreterNeeded &&
      this.#callerTypeAsks === 0
    ) {
      this.#callerTypeAsks += 1;
      this.#lastQuestion = CALLER_TYPE_CLARIFY_QUESTION;
      return { reply: CALLER_TYPE_CLARIFY_QUESTION, done: false, trace: { ...trace, label: "Caller type unclear — asked once more" } };
    }

    if (!decision.clearedForSubstantiveIntake) {
      this.#pendingGate = decision.directive;
      const reply =
        decision.directive === "disclose_recording_consent_then_continue"
          ? recordingConsentScriptFor(this.#firmConfig)
          : DIRECTIVE_SCRIPTS[decision.directive];
      // What to repeat after a side answer: just the question, not the
      // whole disclosure or preamble again.
      this.#lastQuestion =
        decision.directive === "disclose_recording_consent_then_continue"
          ? CONSENT_REASK_QUESTION
          : decision.directive === "hold_for_conflict_check"
            ? CONFLICT_REASK_QUESTION
            : reply;
      return { reply, done: false, trace };
    }

    if (this.#state.callerType === "billing") {
      return this.#finish(BILLING_HANDOFF_SCRIPT, "Billing caller — handed to the billing team");
    }

    const disclosure = disclosurePolicyFor(this.#state.callerType);
    if (!disclosure.mayShareCaseDetails && this.#state.callerType === "unknown") {
      // Same non-disclosure as a third party, without telling someone who
      // may well be the client that we "can't share case details".
      return this.#finish(UNIDENTIFIED_CALLER_MESSAGE_SCRIPT, "Caller not identified — message only, no case details shared");
    }
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
    this.#lastQuestion = question.prompt;
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

  /** Which kind of question is waiting for an answer, for side-question handling; none while choosing a language. */
  #questionGate(): QuestionGate | undefined {
    switch (this.#pendingGate) {
      case "caller_type":
        return "caller_type";
      case "disclose_recording_consent_then_continue":
        return "consent";
      case "hold_for_conflict_check":
        return "conflict";
      case "intake_question":
        return "intake";
      default:
        return undefined;
    }
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
      const hours = parseHoursUntil(answerText, this.#now());
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
