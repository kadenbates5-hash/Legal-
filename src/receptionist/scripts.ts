import type { RouteDirective } from "../core/escalation.js";
import type { FirmConfig } from "../config/firm-config.js";

/**
 * Canned response text per directive. Kept as plain strings rather than a
 * template engine — this is the receptionist's actual script, not a
 * suggestion the model can improvise around (§2's "hard-coded behaviors,
 * no exceptions").
 */
export const DIRECTIVE_SCRIPTS: Record<RouteDirective, string> = {
  connect_human_immediately:
    "I'm connecting you with someone right now — please stay on the line.",
  connect_crisis_resources_immediately:
    "I'm connecting you with someone right now. If you're in immediate danger, please call 911, or reach the 988 Suicide & Crisis Lifeline by calling or texting 988 — you don't have to go through this alone.",
  connect_human_gently:
    "I hear you, and I want to make sure you get the right support — let me connect you with someone right away.",
  redirect_no_answer_then_handoff:
    "I can't answer that or take down details of what happened, but I'll get you to someone who can help right away.",
  route_to_human_workflow:
    "Understood — I'll make sure a person handles this from here, no AI involved.",
  route_interpreter_then_continue: "What language would you like to continue in?",
  hold_for_conflict_check:
    "Before we go further, I need to check for a few names to make sure there's no conflict of interest. Could you tell me the name of the other party involved, if any?",
  disclose_recording_consent_then_continue:
    "This call may be recorded for quality and record-keeping purposes, as permitted under our state's consent rules. Is that okay with you?",
  continue_standard_triage: "Thanks — let's continue.",
};

const CALLER_TYPE_QUESTION = "Are you a new client, an existing client, or calling on behalf of someone else?";
const DEFAULT_GREETING_OPENER = "Thanks for reaching out.";

export const GREETING = `${DEFAULT_GREETING_OPENER} ${CALLER_TYPE_QUESTION}`;

export const AFTER_HOURS_NOTICE = "Our office is currently closed, but I can still help right now — ";

/**
 * §1 layer 3: firm-level config drives tone/branding here, never core
 * enforcement. Falls back to the generic greeting when no firm config is
 * supplied (e.g. in tests), and prepends an after-hours notice — computed
 * by the caller via `isWithinBusinessHours`, not decided here — without
 * changing anything about escalation availability.
 */
export function greetingFor(firmConfig?: FirmConfig, isAfterHours = false): string {
  const opener = firmConfig?.branding.greeting || DEFAULT_GREETING_OPENER;
  const afterHours = isAfterHours ? AFTER_HOURS_NOTICE : "";
  return `${afterHours}${opener} ${CALLER_TYPE_QUESTION}`;
}

/**
 * Recording-consent disclosure wording varies by jurisdiction — a
 * two-party-consent state needs the caller's affirmative agreement called
 * out explicitly; a one-party-consent state only needs notice. Falls back
 * to generic wording when no firm config is supplied.
 */
export function recordingConsentScriptFor(firmConfig?: FirmConfig): string {
  if (firmConfig?.jurisdictionRecordingConsent === "two-party-consent") {
    return "This call may be recorded for quality and record-keeping purposes. Because our state requires all parties to consent to being recorded, I need your agreement before we continue — is that okay with you?";
  }
  if (firmConfig?.jurisdictionRecordingConsent === "one-party-consent") {
    return "Just so you're aware, this call may be recorded for quality and record-keeping purposes, as permitted under our state's one-party consent rule. Let me know if that's not okay with you.";
  }
  return DIRECTIVE_SCRIPTS.disclose_recording_consent_then_continue;
}

export const THIRD_PARTY_DISCLOSURE_SCRIPT =
  "I can't share case details, but I can pass along a message.";

/**
 * §2 lists "billing question" as its own caller-type category, distinct
 * from a family member/third party. A billing caller shouldn't be walked
 * through the practice-area module's legal intake questions (custody,
 * court date, etc. — nonsensical for someone calling about an invoice),
 * nor told the third-party "I can't share case details" line, which reads
 * as a brush-off for what may be their own account. Since caller identity
 * isn't verified here (§5/§6 — no real auth yet), the safe, correct
 * behavior is a dedicated human handoff for billing specifically, not
 * assuming they're either the verified client or a stranger.
 */
export const BILLING_HANDOFF_SCRIPT =
  "I'll connect you with our billing team for that — they can pull up your account details.";

export const OUTRO_CLEARED_FOR_INTAKE = "A few quick questions to get you started:";

export const WRAP_UP = "That's everything I need for now — someone from our team will follow up with you shortly.";

/** §7 red-teaming: what to say when a caller explicitly declines recording consent. */
export const RECORDING_CONSENT_REFUSED_SCRIPT =
  "Understood — I'll connect you directly with someone so this conversation isn't recorded.";
