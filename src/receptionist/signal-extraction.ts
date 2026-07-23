import type { EscalationSignals } from "../core/escalation.js";

/**
 * Rule-based extraction of escalation-relevant signals from a caller's free
 * text. Deliberately conservative pattern matching, not an LLM judgment
 * call — false positives (over-escalating) are the safe failure mode here,
 * false negatives are not. Practice-area modules can layer their own
 * extraction on top via deriveEscalationSignals; this only covers the core,
 * practice-area-agnostic patterns from §2.
 */
const IN_CUSTODY_RE = /\b(in custody|i(?:'m| am) (?:currently )?(?:in jail|locked up|under arrest|being held)|they arrested me)\b/i;
const IMMINENT_POLICE_RE = /\b(police (?:want|are going|is going) to (?:question|interview|talk to) me|(?:talking|about to talk) to (?:the )?police (?:now|tonight|today)|detective(?:s)? (?:want|need) to (?:speak|talk) (?:with|to) me)\b/i;
const COURT_TODAY_RE = /\bcourt\b.{0,20}\b(today|tomorrow)\b/i;
const COURT_IN_HOURS_RE = /\bcourt\b.{0,20}\bin (\d{1,3}) hours?\b/i;
const PROTECTIVE_ORDER_RE = /\b(protective order|restraining order)\b/i;
const PROTECTIVE_ORDER_ISSUE_RE = /\b(violat|arrest|police (?:showed up|came)|they said i broke)/i;
const LEGAL_ADVICE_RE = /\b(am i going to (?:jail|prison)|do i have a case|should i (?:talk|speak) to (?:the )?police|what should i (?:do|say)|is (?:this|that) legal|can they (?:do that|arrest me)|will i (?:go to jail|get convicted))\b/i;
const NARRATIVE_RE = /\b(what happened was|so i was|then (?:he|she|they) |i (?:was|got) (?:arrested|pulled over|stopped) and)\b/i;
const VULNERABLE_RE = /\b(i(?:'m| am) (?:a minor|only \d{1,2}(?: years old)?)|i(?:'ve| have) been drinking|i(?:'m| am) (?:scared|terrified|panicking)|i can(?:'t|not) breathe)\b/i;
const OPT_OUT_RE = /\b(don'?t want (?:an? )?ai|no ai|human only|talk to a human please|opt out of ai)\b/i;
const INTERPRETER_RE = /\b(i (?:don'?t|do not) speak english well|necesito un int[eé]rprete|interpreter|translator)\b/i;

export function extractSignalsFromText(text: string): Partial<EscalationSignals> {
  const signals: Partial<EscalationSignals> = {};

  if (IN_CUSTODY_RE.test(text)) signals.inCustody = true;
  if (IMMINENT_POLICE_RE.test(text)) signals.imminentPoliceQuestioning = true;

  const hoursMatch = text.match(COURT_IN_HOURS_RE);
  if (hoursMatch?.[1]) {
    signals.courtAppearanceWithinHours = Number(hoursMatch[1]);
  } else if (COURT_TODAY_RE.test(text)) {
    signals.courtAppearanceWithinHours = 24;
  }

  if (PROTECTIVE_ORDER_RE.test(text) && PROTECTIVE_ORDER_ISSUE_RE.test(text)) {
    signals.activeProtectiveOrderIssue = true;
  }

  if (LEGAL_ADVICE_RE.test(text)) signals.callerAskedForLegalAdvice = true;
  if (NARRATIVE_RE.test(text)) signals.callerNarratingFacts = true;
  if (VULNERABLE_RE.test(text)) signals.vulnerableCaller = true;
  if (OPT_OUT_RE.test(text)) signals.clientRequestedOptOut = true;
  if (INTERPRETER_RE.test(text)) signals.interpreterNeeded = true;

  return signals;
}
