import { describe, expect, it } from "vitest";
import { levelForScore, renderRiskMemo, scoreRisk, RISK_LEVEL_GUIDANCE } from "../src/core/risk-assessment.js";

const base = {
  description: "Client may face an enhanced sentence if a prior is counted.",
  background: "Plea offer expires Friday.",
  severity: 4,
  severityRationale: "Adds years to the exposure.",
  likelihood: 3,
  likelihoodRationale: "The state has flagged the prior.",
  recommendedApproach: "Challenge the prior's validity before the plea hearing.",
};

describe("scoreRisk", () => {
  it("multiplies severity by likelihood and bands the result at the documented boundaries", () => {
    const cases: Array<[number, number, number, string]> = [
      [1, 1, 1, "low"],
      [2, 2, 4, "low"],
      [1, 5, 5, "medium"],
      [3, 3, 9, "medium"],
      [2, 5, 10, "high"],
      [3, 5, 15, "high"],
      [4, 4, 16, "critical"],
      [5, 5, 25, "critical"],
    ];
    for (const [s, l, score, level] of cases) {
      const r = scoreRisk(s, l);
      expect(r.score).toBe(score);
      expect(r.level).toBe(level);
    }
  });

  it("labels each axis", () => {
    const r = scoreRisk(5, 1);
    expect(r.severityLabel).toBe("Critical");
    expect(r.likelihoodLabel).toBe("Remote");
  });

  it("rejects anything that is not a whole number from 1 to 5", () => {
    for (const bad of [0, 6, -1, 2.5, Number.NaN]) {
      expect(() => scoreRisk(bad, 3)).toThrow(/severity/);
      expect(() => scoreRisk(3, bad)).toThrow(/likelihood/);
    }
  });

  it("covers every score from 1 to 25 with exactly one level", () => {
    for (let n = 1; n <= 25; n += 1) expect(["low", "medium", "high", "critical"]).toContain(levelForScore(n));
  });
});

describe("renderRiskMemo", () => {
  it("computes the level itself and states it in the memo", () => {
    const { content, risk } = renderRiskMemo(base);
    expect(risk.score).toBe(12);
    expect(risk.level).toBe("high");
    expect(content).toMatch(/HIGH RISK \(score 12 = severity 4 x likelihood 3\)/);
    expect(content).toContain("Adds years to the exposure.");
  });

  it("includes the action guidance for that level, and escalates a critical one to the managing attorney", () => {
    const high = renderRiskMemo(base).content;
    expect(high).toContain(RISK_LEVEL_GUIDANCE.high.actions[0]!);
    const critical = renderRiskMemo({ ...base, severity: 5, likelihood: 5 }).content;
    expect(critical).toMatch(/managing attorney/);
    expect(critical).toMatch(/malpractice carrier/);
  });

  it("requires a description, both rationales and a recommended approach", () => {
    expect(() => renderRiskMemo({ ...base, description: "  " })).toThrow(/risk description is required/);
    expect(() => renderRiskMemo({ ...base, severityRationale: "" })).toThrow(/severity rationale is required/);
    expect(() => renderRiskMemo({ ...base, likelihoodRationale: "" })).toThrow(/likelihood rationale is required/);
    expect(() => renderRiskMemo({ ...base, recommendedApproach: "" })).toThrow(/recommended approach is required/);
  });

  it("renders optional lists and a mitigation table when given, and says so when empty", () => {
    const empty = renderRiskMemo(base).content;
    expect(empty).toMatch(/None identified yet\./);
    const full = renderRiskMemo({
      ...base,
      contributingFactors: ["Prior is recent"],
      mitigationOptions: [{ option: "Motion to strike prior", effectiveness: "high", effort: "medium", recommended: true }],
      nextSteps: ["File motion by Thursday"],
    }).content;
    expect(full).toContain("- Prior is recent");
    expect(full).toContain("| Motion to strike prior | high | medium | yes |");
    expect(full).toContain("- File motion by Thursday");
  });
});
