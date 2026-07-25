import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { IntakeDemoSessions } from "../src/review-ui/intake-demo.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const receptionist: Actor = { id: "r1", role: "receptionist" };
const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeSessions() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  return new IntakeDemoSessions({ accessControl, auditLog, module: criminalLawModule });
}

describe("IntakeDemoSessions (unit)", () => {
  it("starts a session with the receptionist's caller-type greeting", () => {
    const sessions = makeSessions();
    const { sessionId, turn } = sessions.start(receptionist);
    expect(sessionId).toBeTruthy();
    expect(turn.reply).toMatch(/new client|existing client/i);
    expect(turn.done).toBe(false);
  });

  it("progresses a real conversation through the same router/escalation logic as any other channel", () => {
    const sessions = makeSessions();
    const { sessionId } = sessions.start(receptionist);
    const r1 = sessions.handleMessage(sessionId, "I'm currently in jail and need help");
    expect(r1.reply).toMatch(/connecting you/i);
    expect(r1.done).toBe(true);
  });

  it("throws a distinguishable error for an unknown session id", () => {
    const sessions = makeSessions();
    expect(() => sessions.handleMessage("nope", "hi")).toThrow(/no intake demo session/);
  });

  it("prunes a session from memory once the conversation is done", () => {
    const sessions = makeSessions();
    const { sessionId } = sessions.start(receptionist);
    sessions.handleMessage(sessionId, "I'm currently in jail and need help"); // ends immediately (emergency)
    expect(() => sessions.handleMessage(sessionId, "hello?")).toThrow(/no intake demo session/);
  });

  it("enforces real access control: an attorney can complete a full demo, a paralegal without an assignment cannot", () => {
    const sessions = makeSessions();

    const attorneyRun = sessions.start(attorney);
    expect(() => sessions.handleMessage(attorneyRun.sessionId, "I'm a new client")).not.toThrow();

    const paralegalRun = sessions.start(paralegal);
    sessions.handleMessage(paralegalRun.sessionId, "I'm a new client");
    sessions.handleMessage(paralegalRun.sessionId, "sure, that's fine");
    expect(() => sessions.handleMessage(paralegalRun.sessionId, "no conflicting parties")).toThrow(AccessDeniedError);
  });
});

describe("intake demo HTTP API", () => {
  let server: Server;
  let baseUrl: string;
  let auth: AuthService;

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
    auth = new AuthService();
    auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const intake = new IntakeDemoSessions({ accessControl, auditLog, module: criminalLawModule });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { intake });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("404s when the intake demo isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const noIntakeServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noIntakeServer.listen(0, resolve));
    const { port } = noIntakeServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/intake/start`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noIntakeServer.close(() => resolve()));
  });

  it("rejects starting a demo with no session", async () => {
    const res = await fetch(`${baseUrl}/api/intake/start`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("starts a session and exchanges turns through to an emergency escalation", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const startRes = await fetch(`${baseUrl}/api/intake/start`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.sessionId).toBeTruthy();
    expect(started.reply).toMatch(/new client|existing client/i);

    const msgRes = await fetch(
      `${baseUrl}/api/intake/${started.sessionId}/message`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ text: "I'm currently in jail and need help" }) }),
    );
    expect(msgRes.status).toBe(200);
    const turn = await msgRes.json();
    expect(turn.reply).toMatch(/connecting you/i);
    expect(turn.done).toBe(true);
  });

  it("returns 404 for a message sent to an unknown or already-finished session", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(
      `${baseUrl}/api/intake/does-not-exist/message`,
      withCookie(cookie, { method: "POST", body: JSON.stringify({ text: "hi" }) }),
    );
    expect(res.status).toBe(404);
  });
});
