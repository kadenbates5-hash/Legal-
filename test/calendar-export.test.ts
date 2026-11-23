import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CalendarExportService } from "../src/review-ui/calendar-export-service.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const NOW = new Date("2026-11-23T12:00:00Z");
const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };

function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
}

/** Each VEVENT as a map of property name (before ; or :) to its value line. */
function events(ics: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  let inAlarm = false;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT") {
      out.push(current!);
      current = undefined;
    } else if (line === "BEGIN:VALARM") inAlarm = true;
    else if (line === "END:VALARM") inAlarm = false;
    else if (current && !inAlarm) {
      const name = line.split(/[;:]/, 1)[0]!;
      current[name] = line;
    }
  }
  return out;
}

function setup() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-assigned");
  const deadlines = new DeadlineTracker();
  // Confirmed: two independent sources agree.
  deadlines.record({ matterId: "m-assigned", type: "arraignment", date: "2026-12-01", source: "agent" });
  deadlines.record({ matterId: "m-assigned", type: "arraignment", date: "2026-12-01", source: "human", recordedBy: "a1" });
  // Unconfirmed: one source.
  deadlines.record({ matterId: "m-other", type: "speedy_trial", date: "2026-12-10", source: "agent" });
  // Disputed: two sources disagree.
  deadlines.record({ matterId: "m-other", type: "discovery_response", date: "2026-12-20", source: "agent" });
  deadlines.record({ matterId: "m-other", type: "discovery_response", date: "2026-12-15", source: "human", recordedBy: "a1" });
  // Too old to bother with, and too far ahead.
  deadlines.record({ matterId: "m-other", type: "bail_hearing", date: "2026-09-01", source: "agent" });
  deadlines.record({ matterId: "m-far", type: "other", date: "2028-06-01", source: "agent" });

  const scheduling = new SchedulingService({ accessControl });
  const booked = scheduling.scheduleConsultation(attorney, { matterId: "m-assigned", startTime: new Date("2026-11-30T15:00:00Z"), attorneyId: "a1", durationMinutes: 45 });
  const other = scheduling.scheduleConsultation(attorney, { matterId: "m-other", startTime: new Date("2026-12-02T16:00:00Z"), attorneyId: "a1" });
  const cancelled = scheduling.scheduleConsultation(attorney, { matterId: "m-other", startTime: new Date("2026-12-03T16:00:00Z"), attorneyId: "a1" });
  scheduling.cancel(attorney, cancelled.id, "client asked");
  const done = scheduling.scheduleConsultation(attorney, { matterId: "m-other", startTime: new Date("2026-12-04T16:00:00Z"), attorneyId: "a1" });
  scheduling.complete(attorney, done.id);
  scheduling.scheduleConsultation(attorney, { matterId: "m-other", startTime: new Date("2026-11-20T16:00:00Z"), attorneyId: "a1" });

  const service = new CalendarExportService({
    reviewGate: new ReviewGateService(new WorkProductStore(), deadlines),
    scheduling,
    auditLog,
    nameFor: (id) => (id === "a1" ? "Ada Brooks" : undefined),
    firmName: "Brooks & Park",
  });
  return { service, auditLog, ids: { booked: booked.id, other: other.id, cancelled: cancelled.id } };
}

describe("calendar export", () => {
  it("titles each deadline by how far it can be trusted", () => {
    const { service } = setup();
    const result = service.export(attorney, { now: NOW });
    const summaries = events(result.ics)
      .filter((e) => e["CATEGORIES"]?.includes("Deadline"))
      .map((e) => e["SUMMARY"]);
    expect(summaries).toEqual([
      "SUMMARY:Arraignment — m-assigned",
      "SUMMARY:UNVERIFIED: Speedy-trial deadline — m-other",
      "SUMMARY:DISPUTED: Discovery response due — m-other",
    ]);
    expect(result.deadlineCount).toBe(3);
  });

  it("puts a disputed deadline on the soonest proposed date and names every proposal", () => {
    const { service } = setup();
    const disputed = events(service.export(attorney, { now: NOW }).ics).find((e) => e["SUMMARY"]?.includes("DISPUTED"))!;
    expect(disputed["DTSTART"]).toBe("DTSTART;VALUE=DATE:20261215");
    expect(disputed["DESCRIPTION"]).toContain("2026-12-15");
    expect(disputed["DESCRIPTION"]).toContain("2026-12-20");
    expect(disputed["STATUS"]).toBe("STATUS:TENTATIVE");
  });

  it("marks only a confirmed deadline as confirmed, and never blocks time for one", () => {
    const { service } = setup();
    const deadlines = events(service.export(attorney, { now: NOW }).ics).filter((e) => e["CATEGORIES"]?.includes("Deadline"));
    expect(deadlines.map((e) => e["STATUS"])).toEqual(["STATUS:CONFIRMED", "STATUS:TENTATIVE", "STATUS:TENTATIVE"]);
    expect(deadlines.every((e) => e["TRANSP"] === "TRANSP:TRANSPARENT")).toBe(true);
  });

  it("exports upcoming appointments with the attorney's name, and a cancellation as a cancellation", () => {
    const { service } = setup();
    const result = service.export(attorney, { now: NOW });
    const appts = events(result.ics).filter((e) => e["CATEGORIES"]?.includes("Appointment"));
    expect(appts.map((e) => e["SUMMARY"])).toEqual([
      "SUMMARY:Consultation — m-assigned with Ada Brooks",
      "SUMMARY:Consultation — m-other with Ada Brooks",
      "SUMMARY:CANCELLED: Consultation — m-other with Ada Brooks",
    ]);
    expect(appts[0]!["DTSTART"]).toBe("DTSTART:20261130T150000Z");
    expect(appts[0]!["DTEND"]).toBe("DTEND:20261130T154500Z");
    expect(appts[2]!["STATUS"]).toBe("STATUS:CANCELLED");
    // Completed and past appointments are left out.
    expect(result.appointmentCount).toBe(3);
  });

  it("keeps event ids stable, so importing a newer export updates rather than duplicates", () => {
    const first = setup();
    const a = events(first.service.export(attorney, { now: NOW }).ics).map((e) => e["UID"]);
    const b = events(first.service.export(attorney, { now: new Date("2026-11-24T09:00:00Z") }).ics).map((e) => e["UID"]);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it("gives a paralegal their own matter's appointments and no deadlines, as their panels do", () => {
    const { service } = setup();
    const result = service.export(paralegal, { now: NOW });
    expect(result.deadlineCount).toBe(0);
    expect(result.deadlinesOmitted).toBe(true);
    expect(result.ics).not.toContain("m-other");
    expect(events(result.ics).map((e) => e["SUMMARY"])).toEqual(["SUMMARY:Consultation — m-assigned with Ada Brooks"]);
  });

  it("gives a receptionist the appointments the Scheduling panel shows, and no deadlines", () => {
    const { service } = setup();
    const result = service.export(receptionist, { now: NOW });
    expect(result.deadlineCount).toBe(0);
    expect(result.appointmentCount).toBeGreaterThan(0);
  });

  it("refuses anyone who isn't staff", () => {
    const { service } = setup();
    for (const role of ["client", "system", "anonymous"] as const) {
      expect(() => service.export({ id: "x", role }, { now: NOW })).toThrow(AccessDeniedError);
    }
  });

  it("records each export with what went out", () => {
    const { service, auditLog } = setup();
    service.export(attorney, { now: NOW });
    const entry = auditLog.read("attorney").find((e) => e.action === "calendar_exported");
    expect(entry?.actor.id).toBe("a1");
    expect(entry?.detail).toBe("deadlines=3 appointments=3");
  });

  it("names the calendar after the firm", () => {
    const { service } = setup();
    expect(unfold(service.export(attorney, { now: NOW }).ics)).toContain("X-WR-CALNAME:Brooks & Park — Docket");
  });
});

describe("calendar export HTTP API", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function start(withExport: boolean): Promise<{ base: string; cookie: string }> {
    const { service, auditLog } = setup();
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
      auditLog,
      ...(withExport ? { calendarExport: service } : {}),
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    return { base, cookie: login.headers.get("set-cookie")!.split(";")[0]! };
  }

  it("serves a calendar file as a download", async () => {
    const { base, cookie } = await start(true);
    const res = await fetch(`${base}/api/calendar/export.ics`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="docket-calendar-\d{4}-\d{2}-\d{2}\.ics"$/);
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  });

  it("404s when not configured, and 401s without a session", async () => {
    const { base, cookie } = await start(false);
    expect((await fetch(`${base}/api/calendar/export.ics`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/calendar/export.ics`)).status).toBe(401);
  });
});
