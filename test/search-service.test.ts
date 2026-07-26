import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { BillingHoursStore } from "../src/core/billing-hours.js";
import { DocumentStore } from "../src/core/document-store.js";
import { MatterStore } from "../src/core/matters.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SearchService } from "../src/review-ui/search-service.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function setup() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");

  const matters = new MatterStore();
  matters.upsert("m-1", {
    title: "State v. Ruiz",
    description: "Traffic stop on Atlantic Avenue",
    parties: [
      { name: "Maria Ruiz", role: "client", note: undefined, email: undefined },
      { name: "The State", role: "adverse", note: undefined, email: undefined },
    ],
  });
  matters.upsert("m-2", {
    title: "Okonkwo appeal",
    description: "Sentencing appeal",
    parties: [{ name: "Ada Okonkwo", role: "client", note: undefined, email: undefined }],
  });

  const workProducts = new WorkProductStore();
  workProducts.register(
    new WorkProduct(
      { id: "wp_1", matterId: "m-1", kind: "motion", content: "MOTION TO SUPPRESS. The traffic stop lacked reasonable suspicion." },
      auditLog,
    ),
  );
  workProducts.register(
    new WorkProduct({ id: "wp_2", matterId: "m-2", kind: "brief", content: "Appellant's brief on sentencing disparity." }, auditLog),
  );

  const documents = new DocumentStore();
  documents.upload({ matterId: "m-1", fileName: "dashcam-transcript.pdf", contentType: "application/pdf", content: "eA==", uploadedBy: "p1" });
  documents.upload({ matterId: "m-2", fileName: "sentencing-order.pdf", contentType: "application/pdf", content: "eA==", uploadedBy: "a1" });

  const research = new ResearchLibrary();
  research.save({ matterId: "m-1", citation: "392 U.S. 1", title: "Terry v. Ohio", note: "Stop and frisk standard", savedBy: "a1" });

  const billingHours = new BillingHoursStore();
  billingHours.log({ matterId: "m-1", actorId: "p1", date: "2026-07-20", hours: 2, description: "Reviewed the dashcam footage" });
  billingHours.log({ matterId: "m-2", actorId: "a1", date: "2026-07-21", hours: 1, description: "Call with appellate counsel" });

  return {
    auditLog,
    service: new SearchService({ accessControl, auditLog, matters, workProducts, documents, research, billingHours }),
  };
}

describe("SearchService — finding things", () => {
  it("finds a matter by its caption", () => {
    const { service } = setup();
    const hits = service.search(attorney, "Ruiz").hits;
    expect(hits.some((h) => h.kind === "matter" && h.id === "m-1")).toBe(true);
  });

  it("finds drafted work product by its text, with a snippet around the match", () => {
    const { service } = setup();
    const hit = service.search(attorney, "reasonable suspicion").hits.find((h) => h.kind === "work_product")!;
    expect(hit.id).toBe("wp_1");
    expect(hit.snippet).toContain("reasonable suspicion");
  });

  it("finds a document by file name", () => {
    const { service } = setup();
    const hit = service.search(attorney, "dashcam").hits.find((h) => h.kind === "document")!;
    expect(hit.title).toBe("dashcam-transcript.pdf");
  });

  it("finds saved research by citation or case name", () => {
    const { service } = setup();
    expect(service.search(attorney, "Terry").hits.some((h) => h.kind === "research")).toBe(true);
    expect(service.search(attorney, "392 U.S. 1").hits.some((h) => h.kind === "research")).toBe(true);
  });

  it("finds logged time, which is often where what happened is described", () => {
    const { service } = setup();
    const hit = service.search(attorney, "dashcam footage").hits.find((h) => h.kind === "time_entry")!;
    expect(hit.meta).toContain("2026-07-20");
  });

  it("finds a party name recorded on a matter", () => {
    const { service } = setup();
    expect(service.search(attorney, "Okonkwo").hits.some((h) => h.kind === "matter" && h.id === "m-2")).toBe(true);
  });

  it("is case-insensitive and ignores punctuation", () => {
    const { service } = setup();
    expect(service.search(attorney, "MOTION to Suppress!").hits.length).toBeGreaterThan(0);
  });
});

describe("SearchService — ranking", () => {
  it("ranks an exact phrase above scattered words", () => {
    const { service } = setup();
    const hits = service.search(attorney, "motion to suppress").hits;
    expect(hits[0]!.id).toBe("wp_1");
  });

  it("ranks a title match above a body match", () => {
    const { service } = setup();
    // "Ruiz" is the matter caption and also appears nowhere else, so the
    // matter should lead; a body-only hit must not outrank it.
    const hits = service.search(attorney, "Ruiz").hits;
    expect(hits[0]!.kind).toBe("matter");
  });

  it("returns nothing for a query with no real terms", () => {
    const { service } = setup();
    for (const noise of ["", "   ", "a", "?!"]) {
      expect(service.search(attorney, noise).hits).toEqual([]);
    }
  });

  it("caps results and says when it did", () => {
    const { service } = setup();
    const capped = service.search(attorney, "the", { limit: 1 });
    expect(capped.hits).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });
});

describe("SearchService — access control", () => {
  it("silently omits matters a paralegal isn't assigned to", () => {
    const { service } = setup();
    // The attorney sees both matters' content...
    expect(service.search(attorney, "Okonkwo").hits.length).toBeGreaterThan(0);
    // ...the paralegal, assigned only to m-1, sees none of it.
    const theirs = service.search(paralegal, "Okonkwo");
    expect(theirs.hits).toEqual([]);
    // And no hint that anything was withheld.
    expect(JSON.stringify(theirs)).not.toContain("m-2");
  });

  it("never returns a hit from an unreachable matter, whatever the kind", () => {
    const { service } = setup();
    // A query broad enough to touch every store.
    const hits = service.search(paralegal, "sentencing appeal brief order counsel").hits;
    expect(hits.every((h) => h.matterId === "m-1")).toBe(true);
  });

  it("still returns the paralegal's own matter", () => {
    const { service } = setup();
    const hits = service.search(paralegal, "suppress").hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matterId === "m-1")).toBe(true);
  });

  it("is closed to a receptionist entirely", () => {
    const { service } = setup();
    expect(() => service.search(receptionist, "Ruiz")).toThrow(AccessDeniedError);
  });

  it("logs the search, since it reaches across every matter at once", () => {
    const { service, auditLog } = setup();
    service.search(attorney, "reasonable suspicion");
    const entry = auditLog.read("attorney").find((e) => e.action === "search_run")!;
    expect(entry.detail).toContain("query=reasonable suspicion");
    expect(entry.actor.id).toBe("a1");
  });

  it("does not flood the audit log with a denial per record", () => {
    const { service, auditLog } = setup();
    const before = auditLog.count();
    service.search(paralegal, "sentencing appeal brief order counsel");
    // At most one entry per (matter, category) pair — 2 matters × 2
    // categories — plus the search entry itself. Not one per document,
    // work product and time entry scanned, which is what an uncached
    // authorize() would produce and what would drown the log.
    expect(auditLog.count() - before).toBe(2 * 2 + 1);
  });
});

describe("SearchService — honesty about limits", () => {
  it("says outright that file contents are not indexed", () => {
    const { service } = setup();
    const results = service.search(attorney, "Ruiz");
    expect(results.notSearched.join(" ")).toMatch(/contents of uploaded files/i);
  });

  it("does not match text that only exists inside a document's bytes", () => {
    const { service } = setup();
    // "eA==" decodes to "x"; nothing in the stored content is searchable,
    // and pretending otherwise would be the trap the caveat warns about.
    expect(service.search(attorney, "eA==").hits.some((h) => h.kind === "document")).toBe(false);
  });
});
