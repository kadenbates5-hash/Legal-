import { describe, expect, it } from "vitest";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };

function makeWorkProduct() {
  return new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft text" }, new AuditLog());
}

describe("human-in-the-loop review gate", () => {
  it("blocks release before any review has happened", () => {
    const wp = makeWorkProduct();
    expect(() => wp.release(attorney)).toThrow(ReviewGateError);
  });

  it("blocks release before approval, even after submission", () => {
    const wp = makeWorkProduct();
    wp.submitForReview(paralegal);
    expect(() => wp.release(attorney)).toThrow(ReviewGateError);
  });

  it("only an attorney can approve or release", () => {
    const wp = makeWorkProduct();
    wp.submitForReview(paralegal);
    expect(() => wp.approve(paralegal)).toThrow(ReviewGateError);
  });

  it("full happy path: draft -> submit -> approve -> release", () => {
    const wp = makeWorkProduct();
    wp.submitForReview(paralegal);
    wp.approve(attorney);
    expect(wp.status).toBe("approved");
    wp.release(attorney);
    expect(wp.status).toBe("released");
  });

  it("an attorney can send work back for revision, and it can be resubmitted", () => {
    const wp = makeWorkProduct();
    wp.submitForReview(paralegal);
    wp.requestRevision(attorney, "fix the caption");
    expect(wp.status).toBe("revision_requested");
    wp.submitForReview(paralegal);
    expect(wp.status).toBe("pending_review");
  });

  it("cannot approve while an unresolved flag (e.g. Padilla advisory) is set", () => {
    const wp = makeWorkProduct();
    wp.addFlag("padilla_advisory_required");
    wp.submitForReview(paralegal);
    expect(() => wp.approve(attorney)).toThrow(ReviewGateError);

    wp.clearFlag(attorney, "padilla_advisory_required");
    wp.approve(attorney);
    expect(wp.status).toBe("approved");
  });

  it("only an attorney can clear a flag", () => {
    const wp = makeWorkProduct();
    wp.addFlag("protective_order_no_distribution");
    expect(() => wp.clearFlag(paralegal, "protective_order_no_distribution")).toThrow(ReviewGateError);
  });

  it("records a full transition history", () => {
    const wp = makeWorkProduct();
    wp.submitForReview(paralegal);
    wp.approve(attorney);
    wp.release(attorney);
    expect(wp.history.map((t) => t.to)).toEqual(["pending_review", "approved", "released"]);
  });
});
