import { describe, expect, it } from "vitest";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const paralegal: Actor = { id: "p1", role: "paralegal" };
const otherParalegal: Actor = { id: "p2", role: "paralegal" };
const attorney: Actor = { id: "a1", role: "attorney" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeService(opts?: { utilization?: UtilizationTracker }) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const store = new WorkProductStore();
  const service = new DraftingService({
    accessControl,
    auditLog,
    module: criminalLawModule,
    store,
    ...(opts?.utilization ? { utilization: opts.utilization } : {}),
  });
  return { service, store, accessControl };
}

describe("DraftingService", () => {
  it("denies every method to a non-paralegal/attorney role", () => {
    const { service } = makeService();
    expect(() => service.listTemplates(receptionist)).toThrow(AccessDeniedError);
    expect(() => service.listMatterWorkProduct(receptionist, "m1")).toThrow(AccessDeniedError);
    expect(() =>
      service.draftFromTemplate(receptionist, "m1", { templateId: "engagement_letter", content: "x" }),
    ).toThrow(AccessDeniedError);
  });

  it("lists the practice area's templates", () => {
    const { service } = makeService();
    const templates = service.listTemplates(paralegal);
    expect(templates.some((t) => t.id === "engagement_letter")).toBe(true);
  });

  it("drafts from a template, scoped to the paralegal's assigned matter", () => {
    const { service } = makeService();
    const wp = service.draftFromTemplate(paralegal, "m1", {
      templateId: "engagement_letter",
      content: "Dear client...",
    });
    expect(wp.status).toBe("draft");
    expect(wp.matterId).toBe("m1");
    expect(wp.content).toBe("Dear client...");
  });

  it("denies drafting on a matter the paralegal isn't assigned to", () => {
    const { service } = makeService();
    expect(() =>
      service.draftFromTemplate(paralegal, "m2", { templateId: "engagement_letter", content: "x" }),
    ).toThrow(AccessDeniedError);
  });

  it("lets an attorney draft on any matter (no assignment needed)", () => {
    const { service } = makeService();
    expect(() =>
      service.draftFromTemplate(attorney, "m999", { templateId: "engagement_letter", content: "x" }),
    ).not.toThrow();
  });

  it("drafts a research summary with the mandatory verification flag", () => {
    const { service } = makeService();
    const wp = service.draftResearchSummary(paralegal, "m1", {
      content: "Summary of relevant case law",
      citations: ["State v. Doe, 123 P.3d 456"],
    });
    expect(wp.flags).toContain("research_requires_attorney_verification");
  });

  it("drafts a billing narrative", () => {
    const { service } = makeService();
    const wp = service.draftBillingNarrative(paralegal, "m1", { content: "1.5 hrs reviewing discovery" });
    expect(wp.kind).toBe("billing_narrative");
  });

  it("lists work product for a matter the paralegal is assigned to", () => {
    const { service } = makeService();
    service.draftFromTemplate(paralegal, "m1", { templateId: "engagement_letter", content: "x" });
    const list = service.listMatterWorkProduct(paralegal, "m1");
    expect(list).toHaveLength(1);
  });

  it("denies listing work product for a matter the paralegal isn't assigned to", () => {
    const { service } = makeService();
    expect(() => service.listMatterWorkProduct(paralegal, "m2")).toThrow(AccessDeniedError);
  });

  it("revises a draft still in 'draft' status", () => {
    const { service } = makeService();
    const wp = service.draftFromTemplate(paralegal, "m1", { templateId: "engagement_letter", content: "v1" });
    const revised = service.reviseDraft(paralegal, "m1", wp.id, "v2");
    expect(revised.content).toBe("v2");
  });

  it("submits a draft for review", () => {
    const { service } = makeService();
    const wp = service.draftFromTemplate(paralegal, "m1", { templateId: "engagement_letter", content: "x" });
    const submitted = service.submitForReview(paralegal, "m1", wp.id);
    expect(submitted.status).toBe("pending_review");
  });

  it("finishes the utilization entry on submit, even though create and submit are separate calls (separate HTTP requests in practice)", () => {
    const utilization = new UtilizationTracker();
    const { service } = makeService({ utilization });
    const wp = service.draftFromTemplate(paralegal, "m1", { templateId: "engagement_letter", content: "x" });
    expect(utilization.all()[0]?.status).toBe("sent_for_review");

    service.submitForReview(paralegal, "m1", wp.id);
    expect(utilization.all()[0]?.status).toBe("completed");
  });

  it("denies revising or submitting a work product on a matter the paralegal isn't assigned to", () => {
    const { service } = makeService();
    const wp = service.draftFromTemplate(attorney, "m2", { templateId: "engagement_letter", content: "x" });
    expect(() => service.reviseDraft(paralegal, "m2", wp.id, "hijacked")).toThrow(AccessDeniedError);
    expect(() => service.submitForReview(paralegal, "m2", wp.id)).toThrow(AccessDeniedError);
  });

  it("a paralegal assigned to a different matter cannot touch this one's work product, even by guessing the id", () => {
    const { service, accessControl } = makeService();
    accessControl.assignParalegal("p2", "m2");
    const wp = service.draftFromTemplate(paralegal, "m1", { templateId: "engagement_letter", content: "secret" });
    expect(() => service.get(otherParalegal, "m1", wp.id)).toThrow(AccessDeniedError);
  });

  it("throws a not-found error (not an access error) for a real matter but wrong/unknown work-product id", () => {
    const { service } = makeService();
    expect(() => service.get(paralegal, "m1", "nope")).toThrow(/no work product/);
  });

  it("throws not-found when the work-product id exists but belongs to a different matter than claimed", () => {
    const { service, accessControl } = makeService();
    accessControl.assignParalegal("p1", "m2", undefined);
    const wp = service.draftFromTemplate(attorney, "m1", { templateId: "engagement_letter", content: "x" });
    // p1 is now assigned to m2, so claiming m2 for m1's work product should 404, not leak cross-matter content.
    expect(() => service.get(paralegal, "m2", wp.id)).toThrow(/no work product/);
  });
});
