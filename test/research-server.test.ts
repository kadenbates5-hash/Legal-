import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { ResearchService } from "../src/review-ui/research-service.js";
import { ResearchLibrary } from "../src/core/research-library.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import type { CaseLawSearchClient, CaseSearchResult } from "../src/integrations/courtlistener.js";

class FakeSearchClient implements CaseLawSearchClient {
  async search(query: string): Promise<CaseSearchResult[]> {
    return [{ caseName: `Result for ${query}`, citations: ["1 U.S. 1"], court: undefined, dateFiled: undefined, snippet: undefined, url: "https://x" }];
  }
}

let server: Server;
let baseUrl: string;
let paralegalCookie: string;
let attorneyCookie: string;

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
  accessControl.assignParalegal("p1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });

  const research = new ResearchService({ accessControl, library: new ResearchLibrary(), searchClient: new FakeSearchClient() });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { research });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("research HTTP API", () => {
  it("404s when research isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noResearchServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noResearchServer.listen(0, resolve));
    const { port } = noResearchServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/research/search?q=x`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noResearchServer.close(() => resolve()));
  });

  it("rejects requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/research/search?q=x`);
    expect(res.status).toBe(401);
  });

  it("denies receptionists entirely", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/research/search?q=x`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("searches case law", async () => {
    const res = await fetch(`${baseUrl}/api/research/search?q=abortion`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(results[0].caseName).toBe("Result for abortion");
  });

  it("saves and lists a reference on the paralegal's assigned matter", async () => {
    const saveRes = await fetch(
      `${baseUrl}/api/research/matters/m1`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ citation: "410 U.S. 113", title: "Roe v. Wade" }) }),
    );
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();
    expect(saved.title).toBe("Roe v. Wade");

    const listRes = await fetch(`${baseUrl}/api/research/matters/m1`, withCookie(paralegalCookie));
    expect(await listRes.json()).toHaveLength(1);
  });

  it("denies saving on a matter the paralegal isn't assigned to", async () => {
    const res = await fetch(
      `${baseUrl}/api/research/matters/m2`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ citation: "c", title: "t" }) }),
    );
    expect(res.status).toBe(403);
  });

  it("lets an attorney save on any matter and deletes a reference", async () => {
    const saveRes = await fetch(
      `${baseUrl}/api/research/matters/m999`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ citation: "c", title: "t" }) }),
    );
    expect(saveRes.status).toBe(200);
    const saved = await saveRes.json();

    const deleteRes = await fetch(`${baseUrl}/api/research/matters/m999/${saved.id}`, withCookie(attorneyCookie, { method: "DELETE" }));
    expect(deleteRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/research/matters/m999`, withCookie(attorneyCookie));
    expect(await listRes.json()).toHaveLength(0);
  });

  it("returns 404 for an unknown reference id on an accessible matter", async () => {
    const res = await fetch(`${baseUrl}/api/research/matters/m1/nope`, withCookie(paralegalCookie, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
