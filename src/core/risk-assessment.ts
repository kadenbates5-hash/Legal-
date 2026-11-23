/**
 * Legal risk assessment: a severity x likelihood score, the action
 * guidance for each resulting level, and the memo layout. Adapted for a
 * law firm from the `legal-risk-assessment` skill (anthropics/knowledge-
 * work-plugins, Apache-2.0; vendored under `.claude/skills/`).
 *
 * **The score is computed here and nowhere else.** A caller supplies a
 * severity (1-5) and a likelihood (1-5) with the reasoning behind each;
 * it can never supply the resulting score or level. That keeps a drafted
 * memo from claiming a "Low" rating over inputs that multiply to 20,
 * whether the mistake is a typo, a model's arithmetic, or someone
 * nudging the number — the same "enforced in code, not asked of a
 * human" rule as the rest of core.
 *
 * Pure: no store, no access control, no clock. A memo is still only ever
 * a `WorkProduct` draft (see `paralegal/drafting.ts`), so it passes the
 * attorney review gate like everything else.
 */
export const RISK_SEVERITY_LABELS = ["Negligible", "Low", "Moderate", "High", "Critical"] as const;
export const RISK_LIKELIHOOD_LABELS = ["Remote", "Unlikely", "Possible", "Likely", "Almost certain"] as const;

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskScore {
  severity: number;
  likelihood: number;
  score: number;
  level: RiskLevel;
  severityLabel: string;
  likelihoodLabel: string;
}

function assertScale(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be a whole number from 1 to 5 (got ${value})`);
  }
}

/** 1-4 low, 5-9 medium, 10-15 high, 16-25 critical. */
export function levelForScore(score: number): RiskLevel {
  if (score <= 4) return "low";
  if (score <= 9) return "medium";
  if (score <= 15) return "high";
  return "critical";
}

export function scoreRisk(severity: number, likelihood: number): RiskScore {
  assertScale("severity", severity);
  assertScale("likelihood", likelihood);
  const score = severity * likelihood;
  return {
    severity,
    likelihood,
    score,
    level: levelForScore(score),
    severityLabel: RISK_SEVERITY_LABELS[severity - 1]!,
    likelihoodLabel: RISK_LIKELIHOOD_LABELS[likelihood - 1]!,
  };
}

/**
 * What a firm should do at each level. Written for attorneys deciding
 * how far up to take a matter: "escalate" means a supervising or managing
 * attorney, and "outside counsel" includes co-counsel or a specialist.
 */
export const RISK_LEVEL_GUIDANCE: Record<RiskLevel, { label: string; actions: string[] }> = {
  low: {
    label: "Low risk",
    actions: ["Accept and proceed with standard controls", "Note it on the matter file", "Revisit at the next routine file review"],
  },
  medium: {
    label: "Medium risk",
    actions: [
      "Mitigate: take specific steps to reduce the exposure",
      "Assign one attorney or paralegal as owner",
      "Record the mitigation and why it was chosen",
      "Define what change would raise this to high",
    ],
  },
  high: {
    label: "High risk",
    actions: [
      "Escalate to the supervising attorney",
      "Write a specific mitigation plan and a fallback if the risk materializes",
      "Set a regular review cadence (weekly or at each milestone)",
      "Consider outside or co-counsel for specialized advice",
      "Tell the client what the risk is and how it is being handled",
    ],
  },
  critical: {
    label: "Critical risk",
    actions: [
      "Escalate immediately to the managing attorney",
      "Engage outside or co-counsel now",
      "Preserve evidence and issue a hold if proceedings are possible",
      "Notify the firm's malpractice carrier if a claim is conceivable",
      "Make any required regulatory or bar notifications",
      "Review daily until reduced or resolved",
    ],
  },
};

export interface MitigationOption {
  option: string;
  effectiveness: "high" | "medium" | "low";
  effort: "high" | "medium" | "low";
  recommended: boolean;
}

export interface RiskAssessmentInput {
  description: string;
  background: string;
  severity: number;
  severityRationale: string;
  likelihood: number;
  likelihoodRationale: string;
  contributingFactors?: string[];
  mitigatingFactors?: string[];
  mitigationOptions?: MitigationOption[];
  recommendedApproach: string;
  residualRisk?: string;
  monitoringPlan?: string;
  nextSteps?: string[];
}

function bullets(items: string[] | undefined, none: string): string {
  const clean = (items ?? []).map((i) => i.trim()).filter(Boolean);
  return clean.length ? clean.map((i) => `- ${i}`).join("\n") : none;
}

function required(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

/** Validates the input, computes the score, and renders the memo text. */
export function renderRiskMemo(input: RiskAssessmentInput): { content: string; risk: RiskScore } {
  const description = required("risk description", input.description);
  const severityRationale = required("severity rationale", input.severityRationale);
  const likelihoodRationale = required("likelihood rationale", input.likelihoodRationale);
  const recommendedApproach = required("recommended approach", input.recommendedApproach);
  const risk = scoreRisk(input.severity, input.likelihood);
  const guidance = RISK_LEVEL_GUIDANCE[risk.level];

  const options = (input.mitigationOptions ?? []).filter((o) => o.option.trim());
  const optionsTable = options.length
    ? ["| Option | Effectiveness | Effort | Recommended |", "|---|---|---|---|", ...options.map((o) => `| ${o.option.trim()} | ${o.effectiveness} | ${o.effort} | ${o.recommended ? "yes" : "no"} |`)].join("\n")
    : "None identified yet.";

  const content = [
    "LEGAL RISK ASSESSMENT — DRAFT FOR ATTORNEY REVIEW",
    "Privileged and confidential — attorney work product.",
    "",
    `Risk level: ${guidance.label.toUpperCase()} (score ${risk.score} = severity ${risk.severity} x likelihood ${risk.likelihood})`,
    "",
    "1. Risk description",
    description,
    "",
    "2. Background and context",
    input.background.trim() || "Not provided.",
    "",
    "3. Risk analysis",
    `Severity ${risk.severity}/5 — ${risk.severityLabel}: ${severityRationale}`,
    `Likelihood ${risk.likelihood}/5 — ${risk.likelihoodLabel}: ${likelihoodRationale}`,
    "",
    "4. Contributing factors",
    bullets(input.contributingFactors, "None recorded."),
    "",
    "5. Mitigating factors",
    bullets(input.mitigatingFactors, "None recorded."),
    "",
    "6. Mitigation options",
    optionsTable,
    "",
    "7. Recommended approach",
    recommendedApproach,
    "",
    `8. What a ${guidance.label.toLowerCase()} calls for`,
    bullets(guidance.actions, ""),
    "",
    "9. Residual risk",
    input.residualRisk?.trim() || "Not assessed.",
    "",
    "10. Monitoring plan",
    input.monitoringPlan?.trim() || "Not set.",
    "",
    "11. Next steps",
    bullets(input.nextSteps, "None recorded."),
    "",
    "The severity, likelihood and level above are judgments for the reviewing attorney to confirm or change; the score is computed, not asserted.",
  ].join("\n");

  return { content, risk };
}
