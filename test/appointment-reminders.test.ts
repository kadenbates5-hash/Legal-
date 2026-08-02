import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import { AppointmentReminderSender, renderReminderEmail } from "../src/integrations/appointment-reminders.js";
import type { EmailMessage, EmailResult, EmailSender } from "../src/integrations/email-sender.js";
import type { Actor } from "../src/core/types.js";

const SYSTEM_API_KEY = "test-system-key-1234567890";
const receptionist: Actor = { id: "r1", role: "receptionist" };

let server: Server;
let baseUrl: string;
let scheduling: SchedulingService;
let matterStore: MatterStore;
let receptionistCookie: string;

function fakeEmailSender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: "fake",
    canSend: true,
    fromAddress: "firm@example.com",
    sent,
    async send(message: EmailMessage): Promise<EmailResult> {
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
}

/** A reminder due immediately: the offset is far larger than how soon the appointment starts. */
function scheduleWithImmediatelyDueReminder(matterId: string, attorneyId = "a1") {
  return scheduling.scheduleConsultation(receptionist, {
    matterId,
    startTime: new Date(Date.now() + 5_000),
    attorneyId,
  });
}

beforeEach(async () => {
  scheduling = new SchedulingService({ reminderOffsetsMinutes: [60 * 24 * 365] });
  const auth = new AuthService();
  auth.setSystemApiKey(SYSTEM_API_KEY);
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  matterStore = new MatterStore();
  const matters = new MattersService({ store: matterStore, checker: new ConflictChecker(matterStore), accessControl, auditLog });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { scheduling, matters });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
  });
  receptionistCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("renderReminderEmail", () => {
  it("names the appointment type and time in both the subject and body", () => {
    const rendered = renderReminderEmail(
      {
        appointment: { id: "appt1", matterId: "m1", attorneyId: "a1", type: "consultation", startTime: "2026-09-01T14:00:00Z", durationMinutes: 30 },
        reminder: { id: "r1", offsetMinutesBefore: 60, dueAt: "2026-09-01T13:00:00Z" },
      },
      "Acme Legal",
    );
    expect(rendered.subject).toContain("Acme Legal");
    expect(rendered.subject).toContain("consultation");
    expect(rendered.text).toContain("Acme Legal");
    expect(rendered.text).toContain("consultation");
  });
});

describe("AppointmentReminderSender", () => {
  it("emails the client on record and marks the reminder sent via the real Docket API", async () => {
    matterStore.upsert("m1", { title: "State v. Ruiz", parties: [{ name: "Carlos Ruiz", role: "client", note: undefined, email: "carlos@example.com" }] });
    const appt = scheduleWithImmediatelyDueReminder("m1");

    const email = fakeEmailSender();
    const sender = new AppointmentReminderSender({ email, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY, firmName: "Acme Legal" });
    const result = await sender.run();

    expect(result).toEqual({ sent: 1, skipped: 0, failures: [] });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("carlos@example.com");

    // Marked sent for real — a second run finds nothing left to do.
    const updated = scheduling.get({ id: "sys", role: "system" }, appt.id);
    expect(updated?.reminders[0]?.sentAt).toBeTruthy();
    const second = await sender.run();
    expect(second).toEqual({ sent: 0, skipped: 0, failures: [] });
  });

  it("skips a due reminder whose matter has no client email on record, without failing", async () => {
    matterStore.upsert("m1", { title: "State v. Ruiz" });
    scheduleWithImmediatelyDueReminder("m1");

    const email = fakeEmailSender();
    const sender = new AppointmentReminderSender({ email, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    const result = await sender.run();

    expect(result).toEqual({ sent: 0, skipped: 1, failures: [] });
    expect(email.sent).toEqual([]);
  });

  it("records a per-reminder failure rather than aborting the whole run", async () => {
    matterStore.upsert("m1", { title: "A", parties: [{ name: "Client A", role: "client", note: undefined, email: "a@example.com" }] });
    matterStore.upsert("m2", { title: "B", parties: [{ name: "Client B", role: "client", note: undefined, email: "b@example.com" }] });
    scheduleWithImmediatelyDueReminder("m1");
    scheduleWithImmediatelyDueReminder("m2", "a2");

    let calls = 0;
    const failingEmail: EmailSender = {
      name: "flaky",
      canSend: true,
      fromAddress: "firm@example.com",
      async send(message: EmailMessage): Promise<EmailResult> {
        calls++;
        if (message.to === "a@example.com") throw new Error("mailbox rejected");
        return { messageId: "ok" };
      },
    };
    const sender = new AppointmentReminderSender({ email: failingEmail, docketBaseUrl: baseUrl, systemApiKey: SYSTEM_API_KEY });
    const result = await sender.run();

    expect(calls).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("mailbox rejected");
  });

  it("enriches the due-reminders list with a recipient email only for the system credential", async () => {
    matterStore.upsert("m1", { title: "State v. Ruiz", parties: [{ name: "Carlos Ruiz", role: "client", note: undefined, email: "carlos@example.com" }] });
    scheduleWithImmediatelyDueReminder("m1");

    const staffRes = await fetch(`${baseUrl}/api/appointments/reminders/due`, {
      headers: { "Content-Type": "application/json", Cookie: receptionistCookie },
    });
    expect(staffRes.status).toBe(200);
    const staffView = (await staffRes.json()) as Array<{ appointment: { recipientEmail?: string } }>;
    expect(staffView).toHaveLength(1);
    expect(staffView[0]?.appointment.recipientEmail).toBeUndefined();

    const systemRes = await fetch(`${baseUrl}/api/appointments/reminders/due`, {
      headers: { "x-system-api-key": SYSTEM_API_KEY },
    });
    expect(systemRes.status).toBe(200);
    const systemView = (await systemRes.json()) as Array<{ appointment: { recipientEmail?: string } }>;
    expect(systemView[0]?.appointment.recipientEmail).toBe("carlos@example.com");
  });

  it("rejects a wrong system key without sending or marking anything", async () => {
    matterStore.upsert("m1", { title: "State v. Ruiz", parties: [{ name: "Carlos Ruiz", role: "client", note: undefined, email: "carlos@example.com" }] });
    scheduleWithImmediatelyDueReminder("m1");
    const email = fakeEmailSender();
    const sender = new AppointmentReminderSender({ email, docketBaseUrl: baseUrl, systemApiKey: "wrong-key" });
    await expect(sender.run()).rejects.toThrow(/401/);
    expect(email.sent).toEqual([]);
  });
});
