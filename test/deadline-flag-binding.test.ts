import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { AuditLog } from "../src/core/audit.js";
import { AccessControl } from "../src/core/access-control.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DeadlineTracker, DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG } from "../src/core/deadline.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuthService } from "../src/core/auth.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { ReviewGateError, type Actor } from "../src/core/types.js";

/**
 * §3: a calculated deadline is never single-sourced. The flag that
 * enforces it was cleared against whichever deadline type the attorney
 * named, so any deadline already confirmed on the matter cleared a draft
 * whose own date nobody had checked.
 */
const attorney: Actor = { id: "a1", role: "attorney" };
const colleague: Actor = { id: "a2", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const FLAG = DEADLINE_REQUIRES_REDUNDANT_VERIFICATION_FLAG;

function setup() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  const store = new WorkProductStore();
  const tracker = new DeadlineTracker();
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store, deadlineTracker: tracker });
  const review = new ReviewGateService(store, tracker);
  // The arraignment is already settled on this matter: two sources agree.
  tracker.record({ matterId: "m1", type: "arraignment", date: "2026-12-01", source: "agent" });
  review.confirmDeadline(attorney, "m1", "arraignment", "2026-12-01", "human");
  const motion = drafting.draftFromTemplate(paralegal, "m1", {
    templateId: "motion_to_suppress",
    content: "Motion…",
    deadlineType: "speedy_trial",
    deadlineDate: "2026-12-15",
  });
  drafting.submitForReview(paralegal, "m1", motion.id);
  return { auditLog, store, tracker, drafting, review, motion };
}

describe("clearing a draft's deadline flag", () => {
  it("can't be done with a different deadline that happens to be confirmed", () => {
    const { review, motion } = setup();
    expect(() => review.clearFlag(attorney, motion.id, FLAG, "arraignment")).toThrow(/this draft's deadline is 'speedy_trial' \(2026-12-15\)/);
    expect(() => review.clearFlag(attorney, motion.id, FLAG)).toThrow(/'speedy_trial' for matter 'm1' is not yet confirmed/);
    expect(review.get(attorney, motion.id).flags).toContain(FLAG);
  });

  it("checks the draft's own deadline, with nothing to choose", () => {
    const { review, motion } = setup();
    expect(review.get(attorney, motion.id).deadline).toEqual({ type: "speedy_trial", date: "2026-12-15", state: "unconfirmed" });
    review.confirmDeadline(colleague, "m1", "speedy_trial", "2026-12-15", "human");
    expect(review.get(attorney, motion.id).deadline).toMatchObject({ state: "confirmed", confirmedDate: "2026-12-15" });
    expect(review.clearFlag(attorney, motion.id, FLAG).flags).not.toContain(FLAG);
    expect(review.approve(attorney, motion.id).status).toBe("approved");
  });

  it("refuses when the deadline is confirmed for a different date than the draft's", () => {
    const tracker = new DeadlineTracker();
    const store = new WorkProductStore();
    const auditLog = new AuditLog();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "motion_to_suppress", content: "…" }, auditLog);
    wp.addFlag(FLAG);
    wp.attachDeadline({ type: "speedy_trial", date: "2026-12-15" });
    store.register(wp);
    // A state file that lost the agent's calculation; two people agree on another day.
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-12-20", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-12-20", source: "human", recordedBy: "a2" });
    const review = new ReviewGateService(store, tracker);
    expect(() => review.clearFlag(attorney, "wp1", FLAG)).toThrow(/confirmed for 2026-12-20, but this draft says 2026-12-15/);
  });

  it("for a draft saved before it kept its deadline, takes only a type the agent calculated", () => {
    const { tracker, store, motion, auditLog } = setup();
    const { deadline: _, ...older } = store.get(motion.id)!.toSnapshot();
    const legacyStore = new WorkProductStore();
    legacyStore.register(WorkProduct.fromSnapshot(older, auditLog));
    const review = new ReviewGateService(legacyStore, tracker);
    // The arraignment was confirmed by the agent and a person, so this still
    // passes for an old draft — the agent did calculate an arraignment here.
    // A type nobody calculated on this matter doesn't.
    tracker.record({ matterId: "m1", type: "bail_hearing", date: "2026-12-03", source: "human", recordedBy: "a1" });
    tracker.record({ matterId: "m1", type: "bail_hearing", date: "2026-12-03", source: "human", recordedBy: "a2" });
    expect(() => review.clearFlag(attorney, motion.id, FLAG, "bail_hearing")).toThrow(/no 'bail_hearing' deadline was calculated/);
    expect(() => review.clearFlag(attorney, motion.id, FLAG)).toThrow(/requires specifying which deadlineType/);
    review.confirmDeadline(colleague, "m1", "speedy_trial", "2026-12-15", "human");
    expect(review.clearFlag(attorney, motion.id, FLAG, "speedy_trial").flags).not.toContain(FLAG);
  });
});

describe("the deadline a draft carries", () => {
  it("is attached once, while a draft, and survives a restart", () => {
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "k", content: "…" }, new AuditLog());
    wp.attachDeadline({ type: "speedy_trial", date: "2026-12-15" });
    expect(() => wp.attachDeadline({ type: "other", date: "2026-12-16" })).toThrow(ReviewGateError);
    const reloaded = WorkProduct.fromSnapshot(JSON.parse(JSON.stringify(wp.toSnapshot())), new AuditLog());
    expect(reloaded.deadline).toEqual({ type: "speedy_trial", date: "2026-12-15" });

    const submitted = new WorkProduct({ id: "wp2", matterId: "m1", kind: "k", content: "…" }, new AuditLog());
    submitted.submitForReview(paralegal);
    expect(() => submitted.attachDeadline({ type: "other", date: "2026-12-16" })).toThrow(/only be attached while/);
  });

  it("is shown on the Drafting panel's detail too", () => {
    const { drafting, motion } = setup();
    expect(drafting.get(paralegal, "m1", motion.id).deadline).toEqual({ type: "speedy_trial", date: "2026-12-15" });
  });
});

describe("over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  let motionId: string;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const built = setup();
    motionId = built.motion.id;
    server = createReviewServer(built.review, auth, { auditLog: built.auditLog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses an unrelated confirmed deadline, and shows the draft's own", async () => {
    const res = await fetch(`${baseUrl}/api/work-products/${motionId}/clear-flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ flag: FLAG, deadlineType: "arraignment" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/this draft's deadline is 'speedy_trial'/);
    const detail = await (await fetch(`${baseUrl}/api/work-products/${motionId}`, { headers: { cookie } })).json();
    expect(detail.deadline).toEqual({ type: "speedy_trial", date: "2026-12-15", state: "unconfirmed" });
  });
});

describe("the dashboard", () => {
  const app = readFileSync(new URL("../src/review-ui/public/app.js", import.meta.url), "utf8");

  it("never writes a draft's text, or an appointment's attorney, into the page as HTML", () => {
    // A draft can carry text from outside the firm (a report drafted from a
    // client's PDF), and "<CLIENT NAME>" placeholders vanished as tags. In
    // the Drafting textarea, "&amp;" was decoded and saved back as "&".
    expect(app).not.toMatch(/\$\{wp\.content\}/);
    expect(app).toMatch(/<pre>\$\{escapeHtml\(wp\.content\)\}<\/pre>/);
    expect(app).toMatch(/>\$\{escapeHtml\(wp\.content\)\}<\/textarea>/);
    expect(app).not.toMatch(/\$\{appt\.attorneyId\}/);
    expect(app).not.toMatch(/<code>\$\{f\}<\/code>/);
  });
});
