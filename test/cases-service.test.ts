import { describe, expect, it } from "vitest";
import { CasesService } from "../src/review-ui/cases-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const workProductStore = new WorkProductStore();
  const documentStore = new DocumentStore();
  return {
    auditLog,
    accessControl,
    workProductStore,
    documentStore,
    cases: new CasesService({ accessControl, workProductStore, documentStore }),
  };
}

describe("CasesService", () => {
  it("denies receptionists entirely", () => {
    const { cases } = makeService();
    expect(() => cases.listCases(receptionist)).toThrow(AccessDeniedError);
  });

  it("an attorney sees every matter known via assignment, drafts, or documents", () => {
    const { cases, documentStore } = makeService();
    documentStore.upload({ matterId: "m2", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "a1" });
    const matterIds = cases.listCases(attorney).map((c) => c.matterId).sort();
    expect(matterIds).toEqual(["m1", "m2"]);
  });

  it("a paralegal only sees their assigned matter, even if other matters have activity", () => {
    const { cases, documentStore } = makeService();
    documentStore.upload({ matterId: "m2", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "a1" });
    const matterIds = cases.listCases(paralegal).map((c) => c.matterId);
    expect(matterIds).toEqual(["m1"]);
  });

  it("surfaces a matter granted to a client even with no document or work product yet", () => {
    // A client can post to the messages thread the moment an attorney
    // grants portal access — staff needs a way to find that matter in
    // Cases before anything else has been filed on it.
    const { cases, accessControl } = makeService();
    accessControl.grantClientAccess("c1", "m3");
    expect(cases.listCases(attorney).map((c) => c.matterId)).toContain("m3");
    // Still scoped normally for a paralegal not assigned to it.
    expect(cases.listCases(paralegal).map((c) => c.matterId)).not.toContain("m3");
  });

  it("summarizes work-product and document counts for a case", () => {
    const { cases, documentStore } = makeService();
    documentStore.upload({ matterId: "m1", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "p1" });
    documentStore.upload({ matterId: "m1", fileName: "b.pdf", contentType: "application/pdf", content: "Yg==", uploadedBy: "p1" });
    const summary = cases.listCases(paralegal).find((c) => c.matterId === "m1");
    expect(summary).toMatchObject({ matterId: "m1", documentCount: 2, workProductCount: 0 });
  });

  it("returns full case detail combining documents and work product", () => {
    const { cases, documentStore } = makeService();
    documentStore.upload({ matterId: "m1", fileName: "a.pdf", contentType: "application/pdf", content: "YQ==", uploadedBy: "p1" });
    const detail = cases.getCase(paralegal, "m1");
    expect(detail.documents).toHaveLength(1);
    expect(detail.workProducts).toHaveLength(0);
  });

  it("denies case detail on a matter the paralegal isn't assigned to", () => {
    const { cases } = makeService();
    expect(() => cases.getCase(paralegal, "m2")).toThrow(AccessDeniedError);
  });
});
