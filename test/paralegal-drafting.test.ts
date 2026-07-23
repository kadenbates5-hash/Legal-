import { describe, expect, it } from "vitest";
import { ParalegalDraftingSession, RESEARCH_REQUIRES_VERIFICATION_FLAG, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG } from "../src/paralegal/drafting.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import { criminalLawModule, PADILLA_ADVISORY_FLAG, PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG } from "../src/modules/criminal-law/index.js";
import { AccessDeniedError, ReviewGateError, type Actor } from "../src/core/types.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

function makeSession(opts?: { assign?: boolean; utilization?: UtilizationTracker }) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  if (opts?.assign !== false) accessControl.assignParalegal("p1", "m1");
  const session = new ParalegalDraftingSession({
    actor: paralegal,
    matterId: "m1",
    accessControl,
    auditLog,
    module: criminalLawModule,
    utilization: opts?.utilization,
  });
  return { session, accessControl, auditLog };
}

describe("paralegal drafting session", () => {
  it("drafts from a known template as a draft-status work product", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({ templateId: "engagement_letter", content: "Dear client..." });
    expect(wp.status).toBe("draft");
    expect(wp.matterId).toBe("m1");
    expect(wp.content).toBe("Dear client...");
  });

  it("throws for an unknown template id", () => {
    const { session } = makeSession();
    expect(() => session.draftFromTemplate({ templateId: "nonexistent", content: "x" })).toThrow(/unknown document template/);
  });

  it("refuses to draft without an active matter assignment", () => {
    const { session } = makeSession({ assign: false });
    expect(() => session.draftFromTemplate({ templateId: "engagement_letter", content: "x" })).toThrow(AccessDeniedError);
  });

  it("hard-triggers the Padilla flag for a plea memo drafted for a noncitizen client, blocking approval", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({
      templateId: "plea_agreement_memo",
      content: "plea terms...",
      context: { clientIsNoncitizen: true },
    });
    expect(wp.flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);

    session.submitForReview(wp);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.approve(attorney);
    expect(wp.status).toBe("approved");
  });

  it("does not flag a plea memo for a citizen client", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({
      templateId: "plea_agreement_memo",
      content: "plea terms...",
      context: { clientIsNoncitizen: false },
    });
    expect(wp.flags.size).toBe(0);
  });

  it("flags protective-order material regardless of template", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({
      templateId: "discovery_request",
      content: "requesting records...",
      context: { isProtectiveOrderMaterial: true },
    });
    expect(wp.flags.has(PROTECTIVE_ORDER_NO_DISTRIBUTION_FLAG)).toBe(true);
  });

  it("flags any deadline-referencing draft for redundant verification, never single-sourced", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({
      templateId: "discovery_request",
      content: "responses due...",
      deadlineDate: "2026-08-01",
    });
    expect(wp.flags.has(DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG)).toBe(true);

    session.submitForReview(wp);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);
  });

  it("always flags research summaries for attorney verification, unconditionally", () => {
    const { session } = makeSession();
    const wp = session.draftResearchSummary({
      content: "Under state v. Doe, the standard is...",
      citations: ["State v. Doe, 123 P.3d 456 (2020)"],
    });
    expect(wp.flags.has(RESEARCH_REQUIRES_VERIFICATION_FLAG)).toBe(true);
    expect(wp.content).toContain("State v. Doe");

    session.submitForReview(wp);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);
  });

  it("refuses to draft a research summary with no citations", () => {
    const { session } = makeSession();
    expect(() => session.draftResearchSummary({ content: "some analysis", citations: [] })).toThrow(/citation/);
  });

  it("scopes billing narratives to billing_internal, separately from case_file drafting", () => {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    // Assigned to the matter but explicitly no case-file-relevant setup needed —
    // billing_internal is its own category and paralegal access to it is
    // granted by the same matter assignment (see access-control.test.ts).
    accessControl.assignParalegal("p1", "m1");
    const session = new ParalegalDraftingSession({
      actor: paralegal,
      matterId: "m1",
      accessControl,
      auditLog,
      module: criminalLawModule,
    });
    const wp = session.draftBillingNarrative({ content: "0.5 hrs drafting discovery request" });
    expect(wp.kind).toBe("billing_narrative");
    expect(wp.status).toBe("draft");
  });

  it("submitForReview transitions the work product and completes its utilization entry", () => {
    const utilization = new UtilizationTracker();
    const { session } = makeSession({ utilization });
    const wp = session.draftFromTemplate({ templateId: "engagement_letter", content: "..." });
    expect(utilization.all()).toHaveLength(1);
    expect(utilization.all()[0]!.status).toBe("sent_for_review");

    session.submitForReview(wp);
    expect(wp.status).toBe("pending_review");
    expect(utilization.all()[0]!.status).toBe("completed");
  });

  it("lets the paralegal revise a draft before submission, but not after", () => {
    const { session } = makeSession();
    const wp = session.draftFromTemplate({ templateId: "engagement_letter", content: "v1" });
    session.reviseDraft(wp, "v2");
    expect(wp.content).toBe("v2");

    session.submitForReview(wp);
    expect(() => session.reviseDraft(wp, "v3 sneaky")).toThrow(ReviewGateError);
  });

  it("logs draft creation and submission to the audit trail", () => {
    const { session, auditLog } = makeSession();
    const wp = session.draftFromTemplate({ templateId: "engagement_letter", content: "..." });
    session.submitForReview(wp);
    const entries = auditLog.read("attorney", { matterId: "m1" });
    expect(entries.some((e) => e.action.includes("transition_pending_review"))).toBe(true);
  });
});
