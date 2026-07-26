/**
 * Shared vocabulary for the core layer. This is the same for every firm and
 * every practice area — practice-area modules extend it, they don't redefine it.
 */

export type AgentRole = "receptionist" | "paralegal";

export type CallerType =
  | "new_client"
  | "existing_client"
  | "family_or_third_party"
  | "billing"
  | "opposing_party_or_unknown"
  | "unknown";

export type Channel = "voice" | "chat";

/** Emergency triggers route straight to a human, bypassing normal queue triage. */
export type EmergencyTrigger =
  | "in_custody"
  | "imminent_police_questioning"
  | "court_appearance_imminent"
  | "active_protective_order"
  | "crisis_risk";

/** Non-emergency but still hard-coded, no-exceptions triggers. */
export type StandardTrigger =
  | "legal_advice_requested"
  | "pre_retention_factual_narrative"
  | "conflict_of_interest_unresolved"
  | "vulnerable_caller"
  | "client_opt_out"
  | "interpreter_required";

export type EscalationTrigger = EmergencyTrigger | StandardTrigger;

/**
 * `"anonymous"` is an unauthenticated party — the only thing that
 * produces one today is a login attempt, where the audit trail needs to
 * record *who claimed to be whom* before any credential was verified.
 * Recording those as `"system"` would be a lie: that role is the calendar
 * integration's machine credential. `AccessControl` default-denies every
 * role it doesn't explicitly model, so an anonymous actor can never reach
 * matter data by construction.
 */
export interface Actor {
  id: string;
  role: AgentRole | "attorney" | "staff" | "system" | "anonymous";
}

export interface MatterRef {
  matterId: string;
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class ReviewGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewGateError";
  }
}
