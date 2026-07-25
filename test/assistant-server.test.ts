import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AssistantService } from "../src/review-ui/assistant-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { ResearchService } from "../src/review-ui/research-service.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { ClaudeClient, ClaudeResponse } from "../src/integrations/anthropic.js";
import type { CaseLawSearchClient, CaseSearchResult } from "../src/integrations/courtlistener.js";

class FakeSearchClient implements CaseLawSearchClient {
  async search(): Promise<CaseSearchResult[]> {
    return [];
  }
}

class FakeClaudeClient implements ClaudeClient {
  async createMessage(): Promise<ClaudeResponse> {
    return { id: "msg_1", role: "assistant", content: [{ type: "text", text: "a reply" }], stop_reason: "end_turn" };
  }
}

let server: Server;
let baseUrl: string;
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
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const workProductStore = new WorkProductStore();
  const documentStore = new DocumentStore();
  const auth = new AuthService();
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });

  const assistant = new AssistantService({
    client: new FakeClaudeClient(),
    auditLog,
    toolDeps: {
      drafting: new DraftingService({ accessControl, auditLog, module: criminalLawModule, store: workProductStore }),
      documents: new DocumentsService({ accessControl, store: documentStore }),
      cases: new CasesService({ accessControl, workProductStore, documentStore }),
      research: new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: new FakeSearchClient() }),
      scheduling: new SchedulingService(),
      reviewGate: new ReviewGateService(workProductStore),
    },
  });

  server = createReviewServer(new ReviewGateService(workProductStore), auth, { assistant });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  receptionistCookie = await loginCookie("reception1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("assistant HTTP API", () => {
  it("404s when the assistant isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noAssistantServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noAssistantServer.listen(0, resolve));
    const { port } = noAssistantServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/assistant/start`, withCookie(cookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noAssistantServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/assistant/start`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("denies receptionists entirely", async () => {
    const res = await fetch(`${baseUrl}/api/assistant/start`, withCookie(receptionistCookie, { method: "POST", body: "{}" }));
    expect(res.status).toBe(403);
  });

  it("starts a session and exchanges a message end to end", async () => {
    const startRes = await fetch(`${baseUrl}/api/assistant/start`, withCookie(paralegalCookie, { method: "POST", body: "{}" }));
    expect(startRes.status).toBe(200);
    const { sessionId } = await startRes.json();
    expect(sessionId).toBeTruthy();

    const messageRes = await fetch(
      `${baseUrl}/api/assistant/${sessionId}/message`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ text: "hi" }) }),
    );
    expect(messageRes.status).toBe(200);
    expect((await messageRes.json()).reply).toBe("a reply");
  });

  it("returns 404 for a message to an unknown session", async () => {
    const res = await fetch(
      `${baseUrl}/api/assistant/nonexistent/message`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ text: "hi" }) }),
    );
    expect(res.status).toBe(404);
  });

  it("ends a session", async () => {
    const startRes = await fetch(`${baseUrl}/api/assistant/start`, withCookie(paralegalCookie, { method: "POST", body: "{}" }));
    const { sessionId } = await startRes.json();

    const endRes = await fetch(`${baseUrl}/api/assistant/${sessionId}/end`, withCookie(paralegalCookie, { method: "POST", body: "{}" }));
    expect(endRes.status).toBe(200);

    const messageRes = await fetch(
      `${baseUrl}/api/assistant/${sessionId}/message`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ text: "hi" }) }),
    );
    expect(messageRes.status).toBe(404);
  });
});
