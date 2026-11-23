import type { FirmConfig } from "../config/firm-config.js";
import { RECORDING_CONSENT_REFUSAL_RE, normalizeCallerText } from "./signal-extraction.js";

/**
 * What callers say in between answering. Two classifiers, both pure:
 *
 * - `classifySideQuestion()` recognises a caller asking *something back*
 *   ("are you a robot?", "how much do you charge?", "sorry, what?") instead
 *   of answering. The chat session answers it briefly and asks the same
 *   question again, without moving on — otherwise "are you a robot?" in
 *   reply to "Are you currently in custody?" was taken as the answer and
 *   the custody question was silently skipped.
 * - `classifyConsentAnswer()` decides whether a reply to the recording
 *   disclosure is a yes, a no, or neither. "No." used to count as consent,
 *   because only a handful of explicit refusal phrases stopped it.
 *
 * Neither ever sees an escalation: `ReceptionistChatSession` checks the
 * caller's words for emergencies, legal-advice questions and opt-outs
 * first, and only a message with none of those reaches these. The answers
 * themselves (`sideAnswerFor`) say nothing about the law, the caller's
 * situation, or what will happen — only what the assistant is, that fees
 * are for the attorney, office details the firm configured, and why a
 * question is asked.
 */
export type SideQuestionKind =
  | "repeat"
  | "identity"
  | "fees"
  | "hours"
  | "office"
  | "callback"
  | "why_recording"
  | "why_conflict"
  | "clarify_caller_type"
  | "other";

export type QuestionGate = "caller_type" | "consent" | "conflict" | "intake";

/** A reply that opens with an answer word is an answer, even if it ends in "?" ("yes?", "no, why?"). */
const ANSWER_OPENER_RE = /^\s*(?:yes|yeah|yep|yup|yea|ya|no|nope|nah|sure|ok|okay|correct|right|maybe|probably|i think|i'?m not sure|not|never|none|nobody|n\/a)\b/i;
const QUESTION_SHAPE_RE = /\?\s*$|^\s*(?:who|what|where|when|why|how|which|are you|is (?:this|that|it)|am i|can you|could you|do you|does (?:this|that|it)|will you|would you|do i have to)\b/i;
const REPEAT_RE = /^\s*(?:(?:um+|uh+|er+|hmm+|oh)[,.\s]+)?(?:what|huh|sorry|pardon(?: me)?|come again|excuse me|say (?:that|it) again|(?:can|could) you (?:repeat|say) (?:that|it|the question)(?: again)?(?: please)?|repeat (?:that|the question)(?: please)?|i didn'?t (?:catch|get|hear) that)\s*[.!?]*\s*$/i;
const IDENTITY_RE = /\b(?:robot|bot|ai|a\.i\.|artificial|automated|machine|computer|real (?:person|human)|human|who (?:is this|am i (?:talking|speaking) (?:to|with)|are you)|what(?:'s| is) your name|your name)\b/i;
const FEES_RE = /\b(?:cost|costs|charge|charges|fee|fees|price|pricing|how much|afford|free consultation|consultation free|payment plan|retainer)\b/i;
const HOURS_RE = /\b(?:hours|open|close|closing|opening)\b/i;
const OFFICE_RE = /\b(?:located|location|address|where are you|office|directions|phone number)\b/i;
const CALLBACK_RE = /\b(?:when will|how long (?:until|before|till|will)|call me back|hear back|follow up|get back to me)\b/i;
const WHY_RECORDING_RE = /\b(?:record|recorded|recording|why|what do you mean|what does that mean)\b/i;
const WHY_CONFLICT_RE = /\b(?:why|what do you mean|what does that mean|conflict|do i have to|what(?:'s| is) that for)\b/i;
const CLARIFY_CALLER_TYPE_RE = /\b(?:what do you mean|what does that mean|why|which one|what'?s the difference)\b/i;

export function classifySideQuestion(rawText: string, gate: QuestionGate): SideQuestionKind | undefined {
  const text = normalizeCallerText(rawText);
  if (REPEAT_RE.test(text)) return "repeat";
  if (ANSWER_OPENER_RE.test(text) || !QUESTION_SHAPE_RE.test(text)) return undefined;
  if (/\brecord/i.test(text)) return "why_recording";
  if (IDENTITY_RE.test(text)) return "identity";
  if (FEES_RE.test(text)) return "fees";
  if (CALLBACK_RE.test(text)) return "callback";
  if (HOURS_RE.test(text)) return "hours";
  if (OFFICE_RE.test(text)) return "office";
  if (gate === "consent" && WHY_RECORDING_RE.test(text)) return "why_recording";
  if (gate === "conflict" && WHY_CONFLICT_RE.test(text)) return "why_conflict";
  if (gate === "caller_type" && CLARIFY_CALLER_TYPE_RE.test(text)) return "clarify_caller_type";
  // An unrecognised question at the conflict gate is still screened as an
  // answer: running a name check over extra words costs nothing, and
  // skipping the screen is the failure that matters.
  if (gate === "conflict") return undefined;
  return "other";
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour12}:${String(m).padStart(2, "0")}${suffix}` : `${hour12}${suffix}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (sorted.length > 2 && contiguous) return `${DAY_NAMES[sorted[0]!]} to ${DAY_NAMES[sorted[sorted.length - 1]!]}`;
  return sorted.map((d) => DAY_NAMES[d]).join(", ");
}

/** The brief answer to a side question. Never legal content, never a promise beyond a follow-up. */
export function sideAnswerFor(kind: SideQuestionKind, firmConfig?: FirmConfig): string {
  switch (kind) {
    case "repeat":
      return "Sure.";
    case "identity":
      return `I'm an automated assistant${firmConfig ? ` for ${firmConfig.firmName}` : " for the firm"}. I take down a few details so the right person can follow up, and you can ask for a person at any time.`;
    case "fees":
      return "I can't quote fees, but the attorney will go over costs with you directly.";
    case "hours": {
      const hours = firmConfig?.businessHours;
      return hours?.days.length
        ? `Our office hours are ${formatDays(hours.days)}, ${formatTime(hours.open)} to ${formatTime(hours.close)}.`
        : "Someone from our team can confirm our office hours when they follow up.";
    }
    case "office": {
      const address = firmConfig?.letterhead?.addressLines?.filter((l) => l.trim()).join(", ");
      const phone = firmConfig?.letterhead?.phone;
      if (address) return `Our office is at ${address}${phone ? `, and our number is ${phone}` : ""}.`;
      return "Someone from our team can give you our office details when they follow up.";
    }
    case "callback":
      return "Someone from our team will follow up as soon as they can.";
    case "why_recording":
      return "It just means the call may be saved for quality and for our records.";
    case "why_conflict":
      return "We check every name against our records so we never take on a case against someone we already represent.";
    case "clarify_caller_type":
      return "I just need to know whether this is about your own legal matter or someone else's.";
    case "other":
      return "That's a good question for our team, and I'll make sure it's passed along.";
  }
}

export type ConsentAnswer = "agree" | "refuse" | "unclear";

/**
 * A plain "no" is a refusal. Exceptions are only the stock phrases where
 * "no" means yes ("no problem", "no, that's fine"). Erring toward refusal
 * is the safe direction: it hands the caller to a person without
 * recording, rather than recording someone who said no.
 */
const PLAIN_REFUSAL_RE = /^\s*(?:no|nope|nah|not really|absolutely not|definitely not|hell no|i'?d rather not|rather not|i'?d prefer not|prefer not|not okay|not ok|i don'?t think so|no way)\b(?![\s,.!]*(?:problem|problemo|worries|worry|issue|prob|that'?s (?:fine|ok|okay|good|alright)|it'?s (?:fine|ok|okay|good|alright)|i don'?t mind|go ahead|that works))/i;
const ANYWHERE_REFUSAL_RE = /\b(?:don'?t (?:want|wanna) (?:to )?be recorded|rather (?:you )?(?:not|didn'?t) record|please don'?t record|not comfortable (?:with|being) record)/i;
const AGREE_RE = /\b(?:yes|yeah|yep|yup|ya|yea|sure|ok|okay|k|fine|alright|all right|go ahead|of course|absolutely|definitely|certainly|agree|agreed|consent|no problem|no worries|that'?s (?:fine|ok|okay|good)|sounds good|that works|why not|don'?t mind|np|correct|understood|got it)\b/i;

export function classifyConsentAnswer(rawText: string): ConsentAnswer {
  const text = normalizeCallerText(rawText);
  if (RECORDING_CONSENT_REFUSAL_RE.test(text) || PLAIN_REFUSAL_RE.test(text) || ANYWHERE_REFUSAL_RE.test(text)) return "refuse";
  if (AGREE_RE.test(text)) return "agree";
  return "unclear";
}
