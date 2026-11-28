import { describe, expect, it } from "vitest";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessControl } from "../src/core/access-control.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { criminalLawModule, PADILLA_ADVISORY_FLAG } from "../src/modules/criminal-law/index.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

/**
 * A cleared flag is an attorney's sign-off on the text in front of them.
 * It used to survive a rewrite: clear the Padilla advisory, ask for a
 * revision, and the rewrite — advisory removed — could be approved with
 * nothing left to stop it.
 */
const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function memo(auditLog = new AuditLog()) {
  const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "plea_agreement_memo", content: "Plea memo. Padilla advisory: …" }, auditLog);
  wp.addFlag(PADILLA_ADVISORY_FLAG);
  return { wp, auditLog };
}

describe("a revision after a flag was cleared", () => {
  it("brings the flag back, so the rewrite can't be approved without a fresh sign-off", () => {
    const { wp, auditLog } = memo();
    wp.submitForReview(paralegal);
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.requestRevision(attorney, "tighten the facts");
    wp.reviseDraft(paralegal, "Plea memo. (advisory removed)");
    expect([...wp.flags]).toEqual([PADILLA_ADVISORY_FLAG]);
    wp.submitForReview(paralegal);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);

    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.approve(attorney);
    expect(wp.status).toBe("approved");
    expect(auditLog.read("attorney").some((e) => e.action === "work_product.wp1.flags_reraised")).toBe(true);
  });

  it("does the same for a flag cleared before the draft was ever submitted", () => {
    const { wp } = memo();
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.reviseDraft(paralegal, "different text");
    expect(wp.flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);
  });

  it("leaves the clearance alone when the text didn't change", () => {
    const { wp } = memo();
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.reviseDraft(paralegal, wp.content);
    expect(wp.flags.size).toBe(0);
  });

  it("re-raises only what was cleared, once", () => {
    const { wp } = memo();
    wp.addFlag("research_requires_verification");
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    wp.reviseDraft(paralegal, "v2");
    wp.reviseDraft(paralegal, "v3");
    expect([...wp.flags].sort()).toEqual([PADILLA_ADVISORY_FLAG, "research_requires_verification"].sort());
  });
});

describe("after a restart", () => {
  it("keeps a clearance pending until the text changes", () => {
    const { wp, auditLog } = memo();
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    const reloaded = WorkProduct.fromSnapshot(JSON.parse(JSON.stringify(wp.toSnapshot())), auditLog);
    expect(reloaded.flags.size).toBe(0);
    reloaded.reviseDraft(paralegal, "v2");
    expect(reloaded.flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);
  });

  it("recovers clearances from the audit log for a snapshot written before they were kept", () => {
    const { wp, auditLog } = memo();
    wp.clearFlag(attorney, PADILLA_ADVISORY_FLAG);
    const { clearedFlags: _, ...older } = wp.toSnapshot();
    const reloaded = WorkProduct.fromSnapshot(older, auditLog);
    expect(reloaded.flags.size).toBe(0);
    reloaded.reviseDraft(paralegal, "v2");
    expect(reloaded.flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);
  });

  it("gives an unapproved draft back a flag that was cleared and then rewritten before the fix", () => {
    const auditLog = new AuditLog();
    // What the old code allowed: cleared, revised, resubmitted, flag gone.
    auditLog.append({ actor: attorney, matterId: "m1", action: "work_product.wp1.clear_flag", detail: `flag=${PADILLA_ADVISORY_FLAG}` });
    auditLog.append({ actor: paralegal, matterId: "m1", action: "work_product.wp1.revise_draft", detail: undefined });
    const older = { id: "wp1", matterId: "m1", kind: "plea_agreement_memo", content: "rewritten", flags: [], history: [] };
    expect(WorkProduct.fromSnapshot({ ...older, status: "pending_review" }, auditLog).flags.has(PADILLA_ADVISORY_FLAG)).toBe(true);
    // An approved or released record is history, and stays as it was.
    expect(WorkProduct.fromSnapshot({ ...older, status: "approved" }, auditLog).flags.size).toBe(0);
    // Cleared again after the rewrite: that sign-off stands.
    auditLog.append({ actor: attorney, matterId: "m1", action: "work_product.wp1.clear_flag", detail: `flag=${PADILLA_ADVISORY_FLAG}` });
    expect(WorkProduct.fromSnapshot({ ...older, status: "pending_review" }, auditLog).flags.size).toBe(0);
  });
});

describe("through the Drafting and Review panels' services", () => {
  it("re-raises the module's Padilla flag when a paralegal revises the memo", () => {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    accessControl.assignParalegal("p1", "m1");
    const store = new WorkProductStore();
    const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store });
    const review = new ReviewGateService(store);

    const draft = drafting.draftFromTemplate(paralegal, "m1", {
      templateId: "plea_agreement_memo",
      content: "Plea memo with an immigration advisory.",
      context: { clientIsNoncitizen: true },
    });
    expect(draft.flags).toContain(PADILLA_ADVISORY_FLAG);
    drafting.submitForReview(paralegal, "m1", draft.id);
    review.clearFlag(attorney, draft.id, PADILLA_ADVISORY_FLAG);
    review.requestRevision(attorney, draft.id, "shorter, please");

    const revised = drafting.reviseDraft(paralegal, "m1", draft.id, "Plea memo, shorter.");
    expect(revised.flags).toContain(PADILLA_ADVISORY_FLAG);
    drafting.submitForReview(paralegal, "m1", draft.id);
    expect(() => review.approve(attorney, draft.id)).toThrow(/unresolved flags/);
  });
});
