import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DeadlineError, DeadlineTracker, type DeadlineCalculation } from "../src/core/deadline.js";
import { ParalegalDraftingSession } from "../src/paralegal/drafting.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AuthService } from "../src/core/auth.js";

/**
 * "Coming due", the deadline digest and the calendar export all find a
 * deadline by comparing its date with today. A date that wasn't one took
 * the deadline off all three, and an empty confirmation from the
 * Deadlines panel did the same to the agent's real date beside it.
 */
const today = "2026-11-25";

function upcoming(tracker: DeadlineTracker) {
  return tracker.listUpcoming({ today, withinDays: 30 }).map((d) => [d.matterId, d.date, d.confirmationState]);
}

describe("recording a deadline", () => {
  it("refuses an empty date, which used to hide the agent's date two days away", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "arraignment", date: "2026-11-27", source: "agent" });
    expect(() => tracker.record({ matterId: "m1", type: "arraignment", date: "", source: "human", recordedBy: "a1" })).toThrow(
      /needs a date/,
    );
    expect(upcoming(tracker)).toEqual([["m1", "2026-11-27", "unconfirmed"]]);
  });

  it("refuses a date that isn't a real day", () => {
    const tracker = new DeadlineTracker();
    for (const date of ["next Friday", "07/29/2026", "2026-02-30", "2026-7-28"]) {
      expect(() => tracker.record({ matterId: "m1", type: "other", date, source: "agent" }), date).toThrow(DeadlineError);
    }
    expect(tracker.toSnapshot()).toEqual([]);
  });

  it("refuses a type it doesn't know and a missing matter", () => {
    const tracker = new DeadlineTracker();
    expect(() =>
      tracker.record({ matterId: "m1", type: "sentencing" as never, date: "2026-12-01", source: "human", recordedBy: "a1" }),
    ).toThrow(/deadline type must be one of/);
    expect(() => tracker.record({ matterId: "  ", type: "other", date: "2026-12-01", source: "agent" })).toThrow(/matter/);
  });

  it("lists a matter whose id contains '::', which used to be looked up under the wrong key", () => {
    const tracker = new DeadlineTracker();
    tracker.record({ matterId: "Ruiz::2026", type: "other", date: "2026-11-30", source: "agent" });
    expect(upcoming(tracker)).toEqual([["Ruiz::2026", "2026-11-30", "unconfirmed"]]);
    expect(tracker.isConfirmed("Ruiz::2026", "other")).toBe(false);
  });

  it("still lists a deadline saved with an empty date before this check, on its real date and as disputed", () => {
    const stored: DeadlineCalculation[] = [
      { matterId: "m1", type: "arraignment", date: "2026-11-27", source: "agent", recordedAt: "2026-11-20T00:00:00Z", note: undefined, recordedBy: undefined },
      { matterId: "m1", type: "arraignment", date: "", source: "human", recordedAt: "2026-11-21T00:00:00Z", note: undefined, recordedBy: "a1" },
    ];
    const tracker = DeadlineTracker.fromSnapshot(stored);
    // Two sources that don't agree: never confirmed, and on the list.
    expect(upcoming(tracker)).toEqual([["m1", "2026-11-27", "conflict"]]);
    expect(tracker.isConfirmed("m1", "arraignment")).toBe(false);
  });

  it("says plainly when today or the horizon isn't usable", () => {
    const tracker = new DeadlineTracker();
    expect(() => tracker.listUpcoming({ today: "garbage", withinDays: 14 })).toThrow(/today must be a real day/);
    expect(() => tracker.listUpcoming({ today, withinDays: 1e9 })).toThrow(/withinDays must be/);
    expect(tracker.listUpcoming({ today, withinDays: 14.5 })).toEqual([]);
  });
});

describe("drafting with a deadline date", () => {
  it("refuses a date that isn't one before the draft exists", () => {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    accessControl.assignParalegal("p1", "m1");
    const store = new WorkProductStore();
    const deadlineTracker = new DeadlineTracker();
    const session = new ParalegalDraftingSession({
      actor: { id: "p1", role: "paralegal" },
      matterId: "m1",
      accessControl,
      auditLog,
      module: criminalLawModule,
      store,
      deadlineTracker,
    });
    expect(() =>
      session.draftFromTemplate({ templateId: "engagement_letter", content: "Dear client", deadlineDate: "next Friday" }),
    ).toThrow(DeadlineError);
    expect(store.listAll()).toEqual([]);
    expect(deadlineTracker.toSnapshot()).toEqual([]);

    const wp = session.draftFromTemplate({ templateId: "engagement_letter", content: "Dear client", deadlineDate: "2026-12-04" });
    expect(store.listAll().map((w) => w.id)).toEqual([wp.id]);
    expect(deadlineTracker.toSnapshot().map((c) => c.date)).toEqual(["2026-12-04"]);
  });
});

describe("POST /api/deadlines/confirm", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  let tracker: DeadlineTracker;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    tracker = new DeadlineTracker();
    tracker.record({ matterId: "m1", type: "arraignment", date: "2026-11-27", source: "agent" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore(), tracker), auth);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const confirm = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/deadlines/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ matterId: "m1", type: "arraignment", source: "human", ...body }),
    });

  it("answers an empty date box with a 400, and the deadline stays on Coming due", async () => {
    const res = await confirm({ date: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/needs a date/);
    expect((await confirm({ type: undefined, date: "2026-11-27" })).status).toBe(400);

    const list = await fetch(`${baseUrl}/api/deadlines/upcoming?today=${today}`, { headers: { cookie } });
    expect((await list.json()).map((d: { matterId: string; date: string }) => [d.matterId, d.date])).toEqual([["m1", "2026-11-27"]]);
  });

  it("still records a real confirmation", async () => {
    const res = await confirm({ date: "2026-11-27" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("confirmed");
  });

  it("refuses an unusable today on the Coming due list with a 400 that says so", async () => {
    const res = await fetch(`${baseUrl}/api/deadlines/upcoming?today=soon`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/today must be a real day/);
  });
});
