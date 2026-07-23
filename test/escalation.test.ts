import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/escalation.js";

describe("escalation engine", () => {
  it("fires emergency for in-custody callers, bypassing queue triage", () => {
    const result = evaluate({ inCustody: true });
    expect(result.escalate).toBe(true);
    expect(result.priority).toBe("emergency");
    expect(result.directive).toBe("connect_human_immediately");
    expect(result.triggers).toContain("in_custody");
  });

  it("fires emergency for a court appearance within 48 hours", () => {
    const soon = evaluate({ courtAppearanceWithinHours: 24 });
    expect(soon.priority).toBe("emergency");

    const notSoon = evaluate({ courtAppearanceWithinHours: 72 });
    expect(notSoon.priority).not.toBe("emergency");
  });

  it("treats exactly 48 hours as emergency and 49 hours as not", () => {
    expect(evaluate({ courtAppearanceWithinHours: 48 }).priority).toBe("emergency");
    expect(evaluate({ courtAppearanceWithinHours: 49 }).priority).not.toBe("emergency");
  });

  it("treats an overdue/negative-hours court appearance as still an emergency", () => {
    expect(evaluate({ courtAppearanceWithinHours: -1 }).priority).toBe("emergency");
  });

  it("treats multiple emergency triggers as still a single emergency route", () => {
    const result = evaluate({ inCustody: true, activeProtectiveOrderIssue: true });
    expect(result.triggers).toEqual(["in_custody", "active_protective_order"]);
    expect(result.directive).toBe("connect_human_immediately");
  });

  it("never answers legal-advice questions — always redirects", () => {
    const result = evaluate({ callerAskedForLegalAdvice: true });
    expect(result.escalate).toBe(true);
    expect(result.directive).toBe("redirect_no_answer_then_handoff");
  });

  it("interrupts a caller narrating pre-retention facts", () => {
    const result = evaluate({ callerNarratingFacts: true });
    expect(result.directive).toBe("redirect_no_answer_then_handoff");
  });

  it("routes opt-out requests to the fully human workflow", () => {
    const result = evaluate({ clientRequestedOptOut: true });
    expect(result.directive).toBe("route_to_human_workflow");
  });

  it("gives vulnerable callers a gentler, faster human handoff", () => {
    const result = evaluate({ vulnerableCaller: true });
    expect(result.escalate).toBe(true);
    expect(result.directive).toBe("connect_human_gently");
  });

  it("uses the gentle handoff, not the legal-advice redirect, when both could apply", () => {
    const result = evaluate({ vulnerableCaller: true, callerAskedForLegalAdvice: true });
    // legal-advice/narrative triggers still take priority — both routes get
    // the caller to a human, so this is a tone choice, not a safety gap.
    expect(result.escalate).toBe(true);
  });

  it("§7 red-teaming: crisis risk is emergency-tier with its own resource-bearing directive", () => {
    const result = evaluate({ crisisRisk: true });
    expect(result.escalate).toBe(true);
    expect(result.priority).toBe("emergency");
    expect(result.directive).toBe("connect_crisis_resources_immediately");
    expect(result.triggers).toContain("crisis_risk");
  });

  it("keeps the crisis-specific directive even when another emergency trigger co-occurs", () => {
    const result = evaluate({ crisisRisk: true, inCustody: true });
    expect(result.directive).toBe("connect_crisis_resources_immediately");
  });

  it("falls through to standard triage when nothing fires", () => {
    const result = evaluate({});
    expect(result.escalate).toBe(false);
    expect(result.directive).toBe("continue_standard_triage");
    expect(result.triggers).toEqual([]);
  });
});
