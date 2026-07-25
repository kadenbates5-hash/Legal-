import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { MessagingService } from "../src/review-ui/messaging-service.js";
import { MessagingStore } from "../src/core/messaging.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;
let receptionistCookie: string;

async function loginCookie(username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return setCookie.split(";")[0]!;
}

function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: cookie } };
}

beforeEach(async () => {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1", displayName: "Ada Attorney" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1", displayName: "Pat Paralegal" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1", displayName: "Rex Reception" });

  const messaging = new MessagingService(new MessagingStore(), auth);
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { messaging });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  receptionistCookie = await loginCookie("reception1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("messaging HTTP API", () => {
  it("404s when messaging isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const noMessagingServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noMessagingServer.listen(0, resolve));
    const { port } = noMessagingServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/messages/conversations`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noMessagingServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/messages/conversations`);
    expect(res.status).toBe(401);
  });

  it("starts a direct conversation and exchanges messages", async () => {
    const startRes = await fetch(
      `${baseUrl}/api/messages/conversations/direct`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ otherActorId: "p1" }) }),
    );
    expect(startRes.status).toBe(200);
    const conversation = await startRes.json();

    const postRes = await fetch(
      `${baseUrl}/api/messages/conversations/${conversation.id}/messages`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ body: "Can you take this matter?" }) }),
    );
    expect(postRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/messages/conversations/${conversation.id}/messages`, withCookie(paralegalCookie));
    expect(listRes.status).toBe(200);
    const messages = await listRes.json();
    expect(messages).toHaveLength(1);
    expect(messages[0].senderName).toBe("Ada Attorney");
  });

  it("denies a non-participant from reading a direct conversation", async () => {
    const startRes = await fetch(
      `${baseUrl}/api/messages/conversations/direct`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ otherActorId: "p1" }) }),
    );
    const conversation = await startRes.json();
    const res = await fetch(`${baseUrl}/api/messages/conversations/${conversation.id}/messages`, withCookie(receptionistCookie));
    expect(res.status).toBe(403);
  });

  it("creates a group conversation and lets a member post", async () => {
    const groupRes = await fetch(
      `${baseUrl}/api/messages/conversations/group`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ name: "Trial Team", memberActorIds: ["p1"] }) }),
    );
    expect(groupRes.status).toBe(200);
    const group = await groupRes.json();

    const postRes = await fetch(
      `${baseUrl}/api/messages/conversations/${group.id}/messages`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ body: "Discovery ready" }) }),
    );
    expect(postRes.status).toBe(200);
  });

  it("lets any authenticated human post and read a firm-wide announcement", async () => {
    const postRes = await fetch(
      `${baseUrl}/api/messages/announcements`,
      withCookie(receptionistCookie, { method: "POST", body: JSON.stringify({ body: "Office closed Friday" }) }),
    );
    expect(postRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/messages/announcements`, withCookie(attorneyCookie));
    const announcements = await listRes.json();
    expect(announcements.map((m: { body: string }) => m.body)).toEqual(["Office closed Friday"]);
  });

  it("lists conversations including the always-present announcements channel", async () => {
    const res = await fetch(`${baseUrl}/api/messages/conversations`, withCookie(receptionistCookie));
    const conversations = await res.json();
    expect(conversations.some((c: { kind: string }) => c.kind === "announcement")).toBe(true);
  });
});
