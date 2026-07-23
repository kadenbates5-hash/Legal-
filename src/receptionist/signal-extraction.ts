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
const COURT_MENTION_RE = /\bcourt\b/i;
const PROTECTIVE_ORDER_RE = /\b(protective order|restraining order)\b/i;
const PROTECTIVE_ORDER_ISSUE_RE = /\b(violat|arrest|police (?:showed up|came)|they said i broke)/i;
const LEGAL_ADVICE_RE = /\b(am i going to (?:jail|prison)|do i have a case|should i (?:talk|speak) to (?:the )?police|what should i (?:do|say)|is (?:this|that) legal|can they (?:do that|arrest me)|will i (?:go to jail|get convicted))\b/i;
const NARRATIVE_RE = /\b(what happened was|so i was|then (?:he|she|they) |i (?:was|got) (?:arrested|pulled over|stopped) and)\b/i;
const VULNERABLE_RE = /\b(i(?:'m| am) (?:a minor|only \d{1,2}(?: years old)?)|i(?:'ve| have) been drinking|i(?:'m| am) (?:scared|terrified|panicking)|i can(?:'t|not) breathe)\b/i;
const OPT_OUT_RE = /\b(don'?t want (?:an? )?ai|no ai|human only|talk to a human please|opt out of ai)\b/i;
const INTERPRETER_RE = /\b(i (?:don'?t|do not) speak english well|necesito un int[eé]rprete|interpreter|translator)\b/i;

const HOURS_RE = /\bin (\d{1,3}) hours?\b/i;
const DAYS_RE = /\bin (\d{1,2}) days?\b/i;
const TODAY_TOMORROW_RE = /\b(today|tomorrow)\b/i;

/**
 * Parses a relative-time phrase ("today", "in 6 hours", "in 2 days") into
 * hours-from-now. Shared by the free-text extractor below (which requires
 * the word "court" nearby) and by the receptionist chat agent's intake
 * answer handling (where the topic — "do you have a court date?" — is
 * already established by the question, so the timing phrase alone is
 * enough). Returns undefined if no recognizable timing phrase is present.
 */
export function parseHoursUntil(text: string): number | undefined {
  const hoursMatch = text.match(HOURS_RE);
  if (hoursMatch?.[1]) return Number(hoursMatch[1]);

  const daysMatch = text.match(DAYS_RE);
  if (daysMatch?.[1]) return Number(daysMatch[1]) * 24;

  if (TODAY_TOMORROW_RE.test(text)) return 24;

  return undefined;
}

export function extractSignalsFromText(text: string): Partial<EscalationSignals> {
  const signals: Partial<EscalationSignals> = {};

  if (IN_CUSTODY_RE.test(text)) signals.inCustody = true;
  if (IMMINENT_POLICE_RE.test(text)) signals.imminentPoliceQuestioning = true;

  if (COURT_MENTION_RE.test(text)) {
    const hours = parseHoursUntil(text);
    if (hours !== undefined) signals.courtAppearanceWithinHours = hours;
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
