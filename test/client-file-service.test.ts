import { describe, expect, it } from "vitest";
import { ClientFileService } from "../src/review-ui/client-file-service.js";
import { MatterStore } from "../src/core/matters.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { DocumentStore } from "../src/core/document-store.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeService() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");

  const matters = new MatterStore();
  matters.upsert("m-1", { title: "State v. Ruiz", parties: [{ name: "Carlos Ruiz", role: "client", note: undefined }] });

  const workProducts = new WorkProductStore();
  workProducts.register(new WorkProduct({ id: "wp1", matterId: "m-1", kind: "engagement_letter", content: "Dear client" }, auditLog));
  workProducts.register(new WorkProduct({ id: "wp2", matterId: "m-other", kind: "motion", content: "Other matter" }, auditLog));

  const documents = new DocumentStore();
  documents.upload({ matterId: "m-1", fileName: "contract.pdf", contentType: "application/pdf", content: "aGk=", uploadedBy: "p1" });

  const research = new ResearchLibrary();
  research.save({ matterId: "m-1", citation: "410 U.S. 113", title: "Roe v. Wade", savedBy: "p1" });

  const billing = new BillingHoursStore();
  billing.log({ matterId: "m-1", actorId: "p1", date: "2026-07-28", hours: 2, description: "Review" });

  const trust = new TrustLedger();
  trust.record({ matterId: "m-1", type: "deposit", amountCents: 500_00, description: "Retainer", recordedBy: "a1" });

  return {
    auditLog,
    service: new ClientFileService({ accessControl, auditLog, matters, workProducts, documents, research, billing, trust }),
  };
}

describe("ClientFileService", () => {
  it("bundles everything the firm holds for the matter", () => {
    const { service } = makeService();
    const bundle = service.export(attorney, "m-1");
    expect(bundle.counts).toEqual({
      workProducts: 1,
      documents: 1,
      researchReferences: 1,
      billingHours: 1,
      trustEntries: 1,
    });
    expect(bundle.matter?.title).toBe("State v. Ruiz");
    expect(bundle.documents[0]!.content).toBe("aGk=");
    expect(bundle.trustLedger.balanceCents).toBe(500_00);
  });

  it("includes only the requested matter", () => {
    const { service } = makeService();
    const bundle = service.export(attorney, "m-1");
    expect(bundle.workProducts.map((w) => w.id)).toEqual(["wp1"]);
  });

  it("is attorney-only — producing a client file is a disclosure decision", () => {
    const { service } = makeService();
    expect(() => service.export(paralegal, "m-1")).toThrow(AccessDeniedError);
  });

  it("carries a notice rather than implying everything in it is the client's to receive", () => {
    const { service } = makeService();
    const bundle = service.export(attorney, "m-1");
    expect(bundle.notice).toMatch(/retaining lien/i);
    expect(bundle.notice).toMatch(/withhold/i);
  });

  it("audits the export with what left, so the firm can evidence what was produced", () => {
    const { service, auditLog } = makeService();
    service.export(attorney, "m-1");
    const entry = auditLog.read("attorney").find((e) => e.action === "client_file_exported");
    expect(entry).toBeDefined();
    expect(entry!.matterId).toBe("m-1");
    expect(entry!.detail).toContain("documents=1");
  });

  it("exports an empty-but-valid bundle for a matter with nothing on file", () => {
    const { service } = makeService();
    const bundle = service.export(attorney, "m-empty");
    expect(bundle.counts.documents).toBe(0);
    expect(bundle.matter).toBeUndefined();
    expect(bundle.trustLedger.balanceCents).toBe(0);
  });
});
