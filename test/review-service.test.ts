import { describe, expect, it } from "vitest";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, ReviewGateError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeService() {
  const store = new WorkProductStore();
  const service = new ReviewGateService(store);
  const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft text" }, new AuditLog());
  store.register(wp);
  return { service, store, wp };
}

describe("ReviewGateService (attorney-only surface)", () => {
  it("denies every method to a non-attorney actor, including plain reads", () => {
    const { service } = makeService();
    expect(() => service.listAll(paralegal)).toThrow(AccessDeniedError);
    expect(() => service.listPendingReview(paralegal)).toThrow(AccessDeniedError);
    expect(() => service.get(paralegal, "wp1")).toThrow(AccessDeniedError);
    expect(() => service.approve(paralegal, "wp1")).toThrow(AccessDeniedError);
  });

  it("lists work product for an attorney", () => {
    const { service } = makeService();
    expect(service.listAll(attorney)).toHaveLength(1);
  });

  it("lists only pending_review items under listPendingReview", () => {
    const { service, wp } = makeService();
    expect(service.listPendingReview(attorney)).toHaveLength(0);
    wp.submitForReview(paralegal);
    expect(service.listPendingReview(attorney)).toHaveLength(1);
  });

  it("gets full detail including content and history", () => {
    const { service, wp } = makeService();
    wp.submitForReview(paralegal);
    const detail = service.get(attorney, "wp1");
    expect(detail.content).toBe("draft text");
    expect(detail.history).toHaveLength(1);
  });

  it("throws a not-found error for an unknown id, distinct from access denial", () => {
    const { service } = makeService();
    expect(() => service.get(attorney, "nope")).toThrow(/no work product/);
  });

  it("drives a work product through approve -> release via the service", () => {
    const { service, wp } = makeService();
    wp.submitForReview(paralegal);
    const approved = service.approve(attorney, "wp1");
    expect(approved.status).toBe("approved");
    const released = service.release(attorney, "wp1");
    expect(released.status).toBe("released");
  });

  it("propagates review-gate errors (e.g. unresolved flags) as ReviewGateError", () => {
    const { service, wp } = makeService();
    wp.addFlag("padilla_advisory_required");
    wp.submitForReview(paralegal);
    expect(() => service.approve(attorney, "wp1")).toThrow(ReviewGateError);

    service.clearFlag(attorney, "wp1", "padilla_advisory_required");
    expect(service.approve(attorney, "wp1").status).toBe("approved");
  });

  it("supports reject and request-revision", () => {
    const { service, wp } = makeService();
    wp.submitForReview(paralegal);
    const revised = service.requestRevision(attorney, "wp1", "fix caption");
    expect(revised.status).toBe("revision_requested");

    wp.submitForReview(paralegal);
    const rejected = service.reject(attorney, "wp1", "not viable");
    expect(rejected.status).toBe("rejected");
  });
});
