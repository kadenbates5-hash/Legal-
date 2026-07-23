import type { EscalationSignals } from "../core/escalation.js";

/**
 * §1 layer 2: practice-area module. Swappable — criminal law today, other
 * areas later — without touching core. A module supplies intake questions,
 * deadline logic, templates, jargon, and escalation triggers specific to
 * its area; it may only ADD escalation signals, never suppress a core one
 * (core's evaluate() has no knob for that — see escalation.ts).
 */
export interface IntakeQuestion {
  id: string;
  prompt: string;
  /** If true, this question must be answered before substantive intake proceeds. */
  gating: boolean;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  /** Flags this template's drafts must carry before an attorney can approve them. See review-gate.ts. */
  requiredFlags: string[];
}

export interface PracticeAreaModule {
  readonly id: string;
  readonly name: string;
  readonly intakeQuestions: IntakeQuestion[];
  readonly templates: DocumentTemplate[];
  /** Practice-area-specific signals derived from module logic, merged into core evaluate() input. */
  deriveEscalationSignals(context: Record<string, unknown>): Partial<EscalationSignals>;
  /**
   * Practice-area-specific work-product flags (e.g. the Padilla advisory)
   * derived from drafting context, merged with the template's static
   * `requiredFlags` by the paralegal drafting engine. Keeps hard-trigger
   * logic like Padilla owned by the criminal-law module instead of living
   * in the practice-area-agnostic drafting engine.
   */
  deriveWorkProductFlags(templateId: string, context: Record<string, unknown>): string[];
}
