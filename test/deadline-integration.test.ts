import { describe, expect, it } from "vitest";
import { ParalegalDraftingSession, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG } from "../src/paralegal/drafting.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

function makeRig() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const store = new WorkProductStore();
  const deadlineTracker = new DeadlineTracker();
  const draftingSession = new ParalegalDraftingSession({
    actor: paralegal,
    matterId: "m1",
    accessControl,
    auditLog,
    module: criminalLawModule,
    store,
    deadlineTracker,
  });
  const reviewService = new ReviewGateService(store, deadlineTracker);
  return { draftingSession, reviewService, deadlineTracker };
}

describe("deadline redundancy end to end: drafting -> review gate", () => {
  it("a paralegal's deadline calculation alone is never enough to clear the flag", () => {
    const { draftingSession, reviewService } = makeRig();
    const wp = draftingSession.draftFromTemplate({
      templateId: "discovery_request",
      content: "responses due...",
      deadlineDate: "2026-09-01",
      deadlineType: "speedy_trial",
    });
    expect(wp.flags.has(DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG)).toBe(true);

    draftingSession.submitForReview(wp);
    expect(() =>
      reviewService.clearFlag(attorney, wp.id, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG, "speedy_trial"),
    ).toThrow(ReviewGateError);
  });

  it("clears once an attorney records an independent confirmation matching the agent's date", () => {
    const { draftingSession, reviewService } = makeRig();
    const wp = draftingSession.draftFromTemplate({
      templateId: "discovery_request",
      content: "responses due...",
      deadlineDate: "2026-09-01",
      deadlineType: "speedy_trial",
    });
    draftingSession.submitForReview(wp);

    reviewService.confirmDeadline(attorney, "m1", "speedy_trial", "2026-09-01", "calendar_system");
    const cleared = reviewService.clearFlag(attorney, wp.id, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG, "speedy_trial");
    expect(cleared.flags).not.toContain(DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG);

    reviewService.approve(attorney, wp.id);
  });

  it("still refuses to clear when the independent source disagrees with the agent — surfaces the conflict instead", () => {
    const { draftingSession, reviewService, deadlineTracker } = makeRig();
    const wp = draftingSession.draftFromTemplate({
      templateId: "discovery_request",
      content: "responses due...",
      deadlineDate: "2026-09-01",
      deadlineType: "speedy_trial",
    });
    draftingSession.submitForReview(wp);

    reviewService.confirmDeadline(attorney, "m1", "speedy_trial", "2026-09-05", "human");
    expect(() =>
      reviewService.clearFlag(attorney, wp.id, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG, "speedy_trial"),
    ).toThrow(ReviewGateError);
    expect(deadlineTracker.status("m1", "speedy_trial").state).toBe("conflict");
    expect(reviewService.listDeadlineConflicts(attorney)).toHaveLength(1);
  });

  it("requires specifying which deadlineType the clear is for — no ambiguous clearing", () => {
    const { draftingSession, reviewService } = makeRig();
    const wp = draftingSession.draftFromTemplate({
      templateId: "discovery_request",
      content: "x",
      deadlineDate: "2026-09-01",
      deadlineType: "speedy_trial",
    });
    draftingSession.submitForReview(wp);
    expect(() => reviewService.clearFlag(attorney, wp.id, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG)).toThrow(
      ReviewGateError,
    );
  });
});
