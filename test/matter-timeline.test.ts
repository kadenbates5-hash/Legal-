import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MatterTimelineService } from "../src/review-ui/matter-timeline-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { AccessControl, type AccessRequest } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { DocumentStore } from "../src/core/document-store.js";
import { MatterStore } from "../src/core/matters.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { InvoiceStore } from "../src/core/invoicing.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
import { ClientMessageStore } from "../src/core/client-messages.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function book(accessControl: AccessControl = new AccessControl(new AuditLog())) {
  const auditLog = new AuditLog();
  accessControl.assignParalegal("p1", "m1");
  const workProducts = new WorkProductStore();
  const documents = new DocumentStore();
  const matters = new MatterStore();
  const deadlines = new DeadlineTracker();
  const scheduling = new SchedulingService({ accessControl });
  const invoices = new InvoiceStore();
  const trust = new TrustLedger();
  const clientMessages = new ClientMessageStore();

  matters.upsert("m1", { title: "State v. Ruiz", status: "open", parties: [] });
  const draft = new WorkProduct({ id: "wp1", matterId: "m1", kind: "template", content: "Motion" }, auditLog);
  draft.submitForReview(paralegal);
  workProducts.register(draft);
  documents.upload({ matterId: "m1", fileName: "police-report.pdf", contentType: "application/pdf", content: "", uploadedBy: "p1" });
  deadlines.record({ matterId: "m1", type: "arraignment", date: "2026-12-01", source: "agent" });
  scheduling.scheduleConsultation(attorney, { matterId: "m1", startTime: new Date("2026-12-02T15:00:00Z"), attorneyId: "a1" });
  const invoice = invoices.createDraft({ matterId: "m1", issuedBy: "a1" });
  invoices.addLineItem(invoice.id, { description: "Motion", source: "flat", quantityMilli: 1000, unitAmountCents: 50000 });
  invoices.send(invoice.id);
  invoices.recordPayment({ invoiceId: invoice.id, amountCents: 20000, method: "check", recordedBy: "a1" });
  trust.record({ matterId: "m1", type: "deposit", amountCents: 250000, description: "Retainer", recordedBy: "a1" });
  clientMessages.post({ matterId: "m1", authorId: "c1", authorRole: "client", body: "When is my next court date?" });
  // Another matter, which must never leak into m1's timeline.
  documents.upload({ matterId: "m2", fileName: "other.pdf", contentType: "application/pdf", content: "", uploadedBy: "a1" });

  return new MatterTimelineService({
    accessControl,
    workProducts,
    documents,
    matters,
    deadlines,
    scheduling,
    invoices,
    trust,
    clientMessages,
    nameFor: (id) => ({ a1: "Ada Brooks", p1: "Pat Lee" })[id],
  });
}

describe("matter timeline", () => {
  it("gives an attorney everything on file for the matter, newest first", () => {
    const { items } = book().timeline(attorney, "m1");
    const kinds = new Set(items.map((i) => i.kind));
    for (const kind of ["matter", "work_product", "document", "deadline", "appointment", "invoice", "payment", "trust", "client_message"]) {
      expect(kinds, kind).toContain(kind);
    }
    const dates = items.map((i) => i.at ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(items.some((i) => i.title.includes("other.pdf"))).toBe(false);
  });

  it("says who did it, and links each item to the panel that owns it", () => {
    const { items } = book().timeline(attorney, "m1");
    const submitted = items.find((i) => i.title.includes("submitted for review"))!;
    expect(submitted.title).toBe("Draft submitted for review by Pat Lee");
    expect(submitted.panel).toBe("queue");
    expect(items.find((i) => i.kind === "trust")!).toMatchObject({ title: "Trust deposit: $2,500.00", panel: "trust" });
    expect(items.find((i) => i.kind === "payment")!.title).toMatch(/^Payment of \$200\.00 on \S+$/);
    expect(items.find((i) => i.kind === "client_message")!).toMatchObject({ title: "Message from the client", detail: "When is my next court date?" });
    // An appointment carries when it's for as a timestamp, for the viewer's own time zone.
    expect(items.find((i) => i.kind === "appointment")!.scheduledFor).toBe("2026-12-02T15:00:00.000Z");
  });

  it("dates a draft from when it was created, even if it was never submitted", () => {
    const service = book();
    const { items } = service.timeline(attorney, "m1");
    const created = items.find((i) => i.title === "Draft created")!;
    expect(created.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("gives an assigned paralegal their matter without deadlines, which are attorney-only", () => {
    const { items } = book().timeline(paralegal, "m1");
    expect(items.some((i) => i.kind === "deadline")).toBe(false);
    expect(items.some((i) => i.kind === "document")).toBe(true);
    // Nothing hints that anything was left out.
    expect(JSON.stringify(items)).not.toMatch(/hidden|omitted|restricted/i);
  });

  it("refuses a matter the viewer can't open at all, exactly as the Cases panel does", () => {
    expect(() => book().timeline(paralegal, "m2")).toThrow(AccessDeniedError);
    for (const role of ["receptionist", "client", "system"] as const) {
      expect(() => book().timeline({ id: "x", role }, "m1")).toThrow(AccessDeniedError);
    }
  });

  it("silently leaves out a source whose own check says no", () => {
    // A stricter rule set that refuses billing to everyone.
    class NoBilling extends AccessControl {
      override authorize(request: AccessRequest): void {
        if (request.category === "billing_internal") throw new AccessDeniedError("no billing here");
        super.authorize(request);
      }
    }
    const { items } = book(new NoBilling(new AuditLog())).timeline(attorney, "m1");
    expect(items.some((i) => i.kind === "invoice" || i.kind === "payment" || i.kind === "trust")).toBe(false);
    expect(items.some((i) => i.kind === "document")).toBe(true);
  });

  it("puts records from before dates were kept at the end rather than guessing", () => {
    const auditLog = new AuditLog();
    const workProducts = new WorkProductStore();
    workProducts.register(
      WorkProduct.fromSnapshot({ id: "old", matterId: "m1", kind: "template", status: "draft", content: "x", flags: [], history: [] }, auditLog),
    );
    const documents = new DocumentStore();
    documents.upload({ matterId: "m1", fileName: "new.pdf", contentType: "application/pdf", content: "", uploadedBy: "a1" });
    const service = new MatterTimelineService({ accessControl: new AccessControl(auditLog), workProducts, documents });
    const { items } = service.timeline(attorney, "m1");
    expect(items.map((i) => i.kind)).toEqual(["document", "work_product"]);
    expect(items[1]!.at).toBeUndefined();
  });

  it("caps a very long history and says so", () => {
    const auditLog = new AuditLog();
    const documents = new DocumentStore();
    for (let i = 0; i < 30; i++) documents.upload({ matterId: "m1", fileName: `f${i}.pdf`, contentType: "application/pdf", content: "", uploadedBy: "a1" });
    const service = new MatterTimelineService({ accessControl: new AccessControl(auditLog), workProducts: new WorkProductStore(), documents });
    const result = service.timeline(attorney, "m1", { maxItems: 10 });
    expect(result.items).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});

describe("GET /api/cases/:matterId/timeline", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function start(withTimeline: boolean) {
    const accessControl = new AccessControl(new AuditLog());
    const timeline = book(accessControl);
    const auth = new AuthService();
    auth.createUser({ username: "atty", password: "correct-horse", role: "attorney", actorId: "a1" });
    auth.createUser({ username: "para", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const cases = new CasesService({ accessControl, workProductStore: new WorkProductStore(), documentStore: new DocumentStore() });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { cases, ...(withTimeline ? { matterTimeline: timeline } : {}) });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const cookieFor = async (username: string) =>
      (
        await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: "correct-horse" }),
        })
      ).headers
        .get("set-cookie")!
        .split(";")[0]!;
    return { base, cookieFor };
  }

  it("serves the timeline, and refuses a matter the caller can't open", async () => {
    const { base, cookieFor } = await start(true);
    const ok = await fetch(`${base}/api/cases/m1/timeline`, { headers: { Cookie: await cookieFor("atty") } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).items.length).toBeGreaterThan(5);
    const denied = await fetch(`${base}/api/cases/m2/timeline`, { headers: { Cookie: await cookieFor("para") } });
    expect(denied.status).toBe(403);
  });

  it("404s when not configured", async () => {
    const { base, cookieFor } = await start(false);
    expect((await fetch(`${base}/api/cases/m1/timeline`, { headers: { Cookie: await cookieFor("atty") } })).status).toBe(404);
  });
});
