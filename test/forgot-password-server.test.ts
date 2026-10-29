import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import type { EmailMessage, EmailResult, EmailSender } from "../src/integrations/email-sender.js";

let server: Server;
let baseUrl: string;
let auth: AuthService;

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

async function startServer(email?: EmailSender) {
  auth = new AuthService();
  auth.createUser({ username: "alice", password: "old-password", role: "attorney", email: "alice@example.com" });
  server = createReviewServer(
    new ReviewGateService(new WorkProductStore()),
    auth,
    email ? { passwordReset: { email, baseUrl: "https://docket.example.com", firmName: "Acme Legal" } } : {},
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /api/forgot-password", () => {
  it("tells the requester self-service reset isn't set up when no passwordReset config is given", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/isn't set up/i);
  });

  it("emails a reset link for a known username, with the same response as an unknown one", async () => {
    const email = fakeEmailSender();
    await startServer(email);

    const known = await fetch(`${baseUrl}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const unknown = await fetch(`${baseUrl}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect((await known.json()).message).toEqual((await unknown.json()).message);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("alice@example.com");
    expect(email.sent[0]?.text).toContain("https://docket.example.com/reset-password.html?token=");
    expect(email.sent[0]?.subject).toContain("Acme Legal");
  });

  it("the emailed link's token actually resets the password", async () => {
    const email = fakeEmailSender();
    await startServer(email);
    await fetch(`${baseUrl}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    const link = email.sent[0]!.text.match(/https:\/\/\S+\/reset-password\.html\?token=(\S+)/)!;
    const token = decodeURIComponent(link[1]!);

    const resetRes = await fetch(`${baseUrl}/api/reset-password/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "brand-new-password" }),
    });
    expect(resetRes.status).toBe(200);

    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "brand-new-password" }),
    });
    expect(loginRes.status).toBe(200);
  });
});

describe("POST /api/reset-password/confirm", () => {
  it("rejects an unknown token with a non-200 status", async () => {
    await startServer(fakeEmailSender());
    const res = await fetch(`${baseUrl}/api/reset-password/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bogus-token", newPassword: "brand-new-password" }),
    });
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toMatch(/invalid or has expired/i);
  });

  it("rejects a reused token", async () => {
    const email = fakeEmailSender();
    await startServer(email);
    await fetch(`${baseUrl}/api/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const token = decodeURIComponent(email.sent[0]!.text.match(/token=(\S+)/)![1]!);

    const first = await fetch(`${baseUrl}/api/reset-password/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "brand-new-password" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/reset-password/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "another-password" }),
    });
    expect(second.status).not.toBe(200);
  });
});
