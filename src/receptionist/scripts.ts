import type { RouteDirective } from "../core/escalation.js";

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

export const GREETING = "Thanks for reaching out. Are you a new client, an existing client, or calling on behalf of someone else?";

export const THIRD_PARTY_DISCLOSURE_SCRIPT =
  "I can't share case details, but I can pass along a message.";

export const OUTRO_CLEARED_FOR_INTAKE = "A few quick questions to get you started:";

export const WRAP_UP = "That's everything I need for now — someone from our team will follow up with you shortly.";

/** §7 red-teaming: what to say when a caller explicitly declines recording consent. */
export const RECORDING_CONSENT_REFUSED_SCRIPT =
  "Understood — I'll connect you directly with someone so this conversation isn't recorded.";
