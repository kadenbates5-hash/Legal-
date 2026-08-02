import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DeadlineTracker } from "../src/core/deadline.js";
import { AuthService } from "../src/core/auth.js";
import { DeadlineAlertSender, renderDeadlineDigest } from "../src/integrations/deadline-alerts.js";
import type { EmailMessage, EmailResult, EmailSender } from "../src/integrations/email-sender.js";

const SYSTEM_API_KEY = "test-system-key-1234567890";

let server: Server;
let baseUrl: string;
let deadlineTracker: DeadlineTracker;
let attorneyCookie: string;

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

beforeEach(async () => {
  deadlineTracker = new DeadlineTracker();
  const auth = new AuthService();
  auth.setSystemApiKey(SYSTEM_API_KEY);
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  const service = new ReviewGateService(new WorkProductStore(), deadlineTracker);
  server = createReviewServer(service, auth);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
  });
  attorneyCookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("renderDeadlineDigest", () => {
  it("names the matter, type, and timing in the body", () => {
    const rendered = renderDeadlineDigest(
      [{ matterId: "m1", type: "speedy_trial", date: "2026-08-01", daysAway: 6, confirmationState: "unconfirmed", overdue: false, urgency: 40 }],
      "Acme Legal",
    );
    expect(rendered.subject).toContain("Acme Legal");
    expect(rendered.text).toContain("m1");
    expect(rendered.text).toContain("speedy trial");
    expect(rendered.text).toContain("2026-08-01");
  });

  it("calls out overdue deadlines in the subject", () => {
    const rendered = renderDeadlineDigest(
      [{ matterId: "m1", type: "arraignment", date: "2026-07-20", daysAway: -6, confirmationState: "unconfirmed", overdue: true, urgency: 142 }],
      "Acme Legal",
    );
    expect(rendered.subject).toMatch(/1 overdue/);
    expect(rendered.text).toMatch(/OVERDUE by 6 day/);
  });
});

describe("DeadlineAlertSender", () => {
  it("sends a digest covering everything the Deadlines panel would show", async () => {
    const soon = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const sooner = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    deadlineTracker.record({ matterId: "m1", type: "speedy_trial", date: soon, source: "agent" });
    deadlineTracker.record({ matterId: "m2", type: "arraignment", date: sooner, source: "agent" });

    const email = fakeEmailSender();
    const sender = new DeadlineAlertSender({
      email,
      docketBaseUrl: baseUrl,
      systemApiKey: SYSTEM_API_KEY,
      recipientEmail: "partners@example.com",
      firmName: "Acme Legal",
      withinDays: 14,
    });
    const result = await sender.run();

    expect(result).toEqual({ sent: true, deadlineCount: 2 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("partners@example.com");
    expect(email.sent[0]?.subject).toContain("Acme Legal");
    expect(email.sent[0]?.text).toContain("m1");
    expect(email.sent[0]?.text).toContain("m2");
  });

  it("sends nothing when nothing is at risk", async () => {
    const email = fakeEmailSender();
    const sender = new DeadlineAlertSender({
      email,
      docketBaseUrl: baseUrl,
      systemApiKey: SYSTEM_API_KEY,
      recipientEmail: "partners@example.com",
    });
    const result = await sender.run();
    expect(result).toEqual({ sent: false, deadlineCount: 0 });
    expect(email.sent).toEqual([]);
  });

  it("rejects a wrong system key without sending anything", async () => {
    deadlineTracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-08-01", source: "agent" });
    const email = fakeEmailSender();
    const sender = new DeadlineAlertSender({
      email,
      docketBaseUrl: baseUrl,
      systemApiKey: "wrong-key",
      recipientEmail: "partners@example.com",
    });
    await expect(sender.run()).rejects.toThrow(/401/);
    expect(email.sent).toEqual([]);
  });

  it("the underlying route is reachable by the system credential in addition to an attorney", async () => {
    deadlineTracker.record({ matterId: "m1", type: "speedy_trial", date: "2026-08-01", source: "agent" });

    const attorneyRes = await fetch(`${baseUrl}/api/deadlines/upcoming`, { headers: { Cookie: attorneyCookie } });
    expect(attorneyRes.status).toBe(200);

    const systemRes = await fetch(`${baseUrl}/api/deadlines/upcoming`, { headers: { "x-system-api-key": SYSTEM_API_KEY } });
    expect(systemRes.status).toBe(200);
  });

  it("still denies a non-attorney, non-system role", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const service = new ReviewGateService(new WorkProductStore(), deadlineTracker);
    const paraServer = createReviewServer(service, auth);
    await new Promise<void>((resolve) => paraServer.listen(0, resolve));
    const paraUrl = `http://127.0.0.1:${(paraServer.address() as AddressInfo).port}`;
    const login = await fetch(`${paraUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${paraUrl}/api/deadlines/upcoming`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    await new Promise<void>((resolve) => paraServer.close(() => resolve()));
  });
});
