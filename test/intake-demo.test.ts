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
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
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
    const r1 = sessions.handleMessage(receptionist, sessionId, "I'm currently in jail and need help");
    expect(r1.reply).toMatch(/connecting you/i);
    expect(r1.done).toBe(true);
  });

  it("throws a distinguishable error for an unknown session id", () => {
    const sessions = makeSessions();
    expect(() => sessions.handleMessage(receptionist, "nope", "hi")).toThrow(/no intake demo session/);
  });

  it("prunes a session from memory once the conversation is done", () => {
    const sessions = makeSessions();
    const { sessionId } = sessions.start(receptionist);
    sessions.handleMessage(receptionist, sessionId, "I'm currently in jail and need help"); // ends immediately (emergency)
    expect(() => sessions.handleMessage(receptionist, sessionId, "hello?")).toThrow(/no intake demo session/);
  });

  it("is for the roles that run intake: an attorney can, anyone else is refused before the call starts", () => {
    const sessions = makeSessions();

    const attorneyRun = sessions.start(attorney);
    expect(() => sessions.handleMessage(attorney, attorneyRun.sessionId, "I'm a new client")).not.toThrow();

    // Refused at the start — not three turns in, after the conflicts
    // screen has already answered whether the firm knows a name.
    for (const actor of [paralegal, { id: "s1", role: "staff" }, { id: "c1", role: "client" }] as Actor[]) {
      expect(() => sessions.start(actor), actor.role).toThrow(AccessDeniedError);
    }
  });

  it("won't screen names for a client against the firm's matters", () => {
    const auditLog = new AuditLog();
    const matters = new MatterStore();
    matters.upsert("m1", { title: "People v. Quill", status: "open", parties: [{ name: "Quill Hartley", role: "client", note: undefined, email: undefined, phone: undefined }] });
    const sessions = new IntakeDemoSessions({
      accessControl: new AccessControl(auditLog),
      auditLog,
      module: criminalLawModule,
      conflictChecker: new ConflictChecker(matters),
    });
    expect(() => sessions.start({ id: "c1", role: "client" })).toThrow(AccessDeniedError);
    // The same three lines from a receptionist reach the screen, as intended.
    const { sessionId } = sessions.start(receptionist);
    sessions.handleMessage(receptionist, sessionId, "I'm a new client, I need a lawyer");
    sessions.handleMessage(receptionist, sessionId, "yes");
    expect(sessions.handleMessage(receptionist, sessionId, "Quill Hartley").trace.label).toMatch(/conflict/i);
  });

  it("lets only the person who started a session continue it", () => {
    const sessions = makeSessions();
    const { sessionId } = sessions.start(receptionist);
    const otherReceptionist: Actor = { id: "r2", role: "receptionist" };
    expect(() => sessions.handleMessage(otherReceptionist, sessionId, "I'm a new client")).toThrow(/no intake demo session/);
    expect(() => sessions.handleMessage(attorney, sessionId, "I'm a new client")).toThrow(/no intake demo session/);
    expect(sessions.handleMessage(receptionist, sessionId, "I'm a new client").done).toBe(false);
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
    auth.createUser({ username: "client1", password: "correct-horse", role: "client", actorId: "c1" });
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

  it("refuses a client account before any call starts (403, not a sign-out)", async () => {
    const cookie = await loginCookie("client1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/intake/start`, { method: "POST", headers: { Cookie: cookie }, body: "{}" });
    expect(res.status).toBe(403);
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

  it("returns a trace on every turn so the training UI can show why the agent said what it said", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const started = await (await fetch(`${baseUrl}/api/intake/start`, withCookie(cookie, { method: "POST", body: "{}" }))).json();
    expect(started.trace.label).toBe("Greeting");
    expect(started.trace.state.callerType).toBe("unknown");

    const turn = await (
      await fetch(
        `${baseUrl}/api/intake/${started.sessionId}/message`,
        withCookie(cookie, { method: "POST", body: JSON.stringify({ text: "I'm currently in jail and need help" }) }),
      )
    ).json();
    expect(turn.trace.label).toMatch(/emergency/i);
    expect(turn.trace.triggers).toContain("in_custody");
  });

  it("lists the training scenarios, each with an id, label, description, and at least one scripted line", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/intake/scenarios`, withCookie(cookie));
    expect(res.status).toBe(200);
    const scenarios = await res.json();
    expect(scenarios.length).toBeGreaterThan(5);
    for (const s of scenarios) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });

  it("requires a session to list scenarios", async () => {
    const res = await fetch(`${baseUrl}/api/intake/scenarios`);
    expect(res.status).toBe(401);
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
