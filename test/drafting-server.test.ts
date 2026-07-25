import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DraftingService } from "../src/review-ui/drafting-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";

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

  const store = new WorkProductStore();
  const drafting = new DraftingService({ accessControl, auditLog, module: criminalLawModule, store });
  server = createReviewServer(new ReviewGateService(store), auth, undefined, undefined, undefined, undefined, drafting);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  paralegalCookie = await loginCookie("paralegal1", "correct-horse");
  attorneyCookie = await loginCookie("attorney1", "correct-horse");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("drafting HTTP API", () => {
  it("404s when drafting isn't configured on the server", async () => {
    const authOnly = new AuthService();
    authOnly.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
    const noDraftingServer = createReviewServer(new ReviewGateService(new WorkProductStore()), authOnly);
    await new Promise<void>((resolve) => noDraftingServer.listen(0, resolve));
    const { port } = noDraftingServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const loginRes = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${url}/api/drafting/templates`, withCookie(cookie));
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => noDraftingServer.close(() => resolve()));
  });

  it("rejects drafting requests with no session", async () => {
    const res = await fetch(`${baseUrl}/api/drafting/templates`);
    expect(res.status).toBe(401);
  });

  it("lists templates", async () => {
    const res = await fetch(`${baseUrl}/api/drafting/templates`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    const templates = await res.json();
    expect(templates.some((t: { id: string }) => t.id === "engagement_letter")).toBe(true);
  });

  it("denies templates/listing to a receptionist", async () => {
    const cookie = await loginCookie("reception1", "correct-horse");
    const res = await fetch(`${baseUrl}/api/drafting/templates`, withCookie(cookie));
    expect(res.status).toBe(403);
  });

  it("drafts from a template on the paralegal's assigned matter", async () => {
    const res = await fetch(
      `${baseUrl}/api/drafting/matters/m1/draft-template`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ templateId: "engagement_letter", content: "Dear client..." }),
      }),
    );
    expect(res.status).toBe(200);
    const wp = await res.json();
    expect(wp.status).toBe("draft");
    expect(wp.matterId).toBe("m1");
  });

  it("denies drafting on a matter the paralegal isn't assigned to", async () => {
    const res = await fetch(
      `${baseUrl}/api/drafting/matters/m2/draft-template`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ templateId: "engagement_letter", content: "x" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("lets an attorney draft on any matter", async () => {
    const res = await fetch(
      `${baseUrl}/api/drafting/matters/m999/draft-template`,
      withCookie(attorneyCookie, {
        method: "POST",
        body: JSON.stringify({ templateId: "engagement_letter", content: "x" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("drafts a research summary with citations", async () => {
    const res = await fetch(
      `${baseUrl}/api/drafting/matters/m1/draft-research`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ content: "Summary", citations: ["State v. Doe"] }),
      }),
    );
    expect(res.status).toBe(200);
    const wp = await res.json();
    expect(wp.flags).toContain("research_requires_attorney_verification");
  });

  it("drafts a billing narrative", async () => {
    const res = await fetch(
      `${baseUrl}/api/drafting/matters/m1/draft-billing`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ content: "1hr research" }) }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe("billing_narrative");
  });

  it("lists a matter's work product", async () => {
    await fetch(
      `${baseUrl}/api/drafting/matters/m1/draft-template`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ templateId: "engagement_letter", content: "x" }) }),
    );
    const res = await fetch(`${baseUrl}/api/drafting/matters/m1`, withCookie(paralegalCookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("gets, revises, and submits a draft end to end", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/drafting/matters/m1/draft-template`,
        withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ templateId: "engagement_letter", content: "v1" }) }),
      )
    ).json();

    const getRes = await fetch(`${baseUrl}/api/drafting/matters/m1/work-products/${created.id}`, withCookie(paralegalCookie));
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).content).toBe("v1");

    const reviseRes = await fetch(
      `${baseUrl}/api/drafting/matters/m1/work-products/${created.id}/revise`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ content: "v2" }) }),
    );
    expect(reviseRes.status).toBe(200);
    expect((await reviseRes.json()).content).toBe("v2");

    const submitRes = await fetch(
      `${baseUrl}/api/drafting/matters/m1/work-products/${created.id}/submit`,
      withCookie(paralegalCookie, { method: "POST", body: "{}" }),
    );
    expect(submitRes.status).toBe(200);
    expect((await submitRes.json()).status).toBe("pending_review");

    // Now shows up in the attorney's review queue.
    const queueRes = await fetch(`${baseUrl}/api/work-products?status=pending_review`, withCookie(attorneyCookie));
    const queue = await queueRes.json();
    expect(queue.some((wp: { id: string }) => wp.id === created.id)).toBe(true);
  });

  it("denies revising/submitting a work product on a matter the paralegal isn't assigned to, even by id", async () => {
    const created = await (
      await fetch(
        `${baseUrl}/api/drafting/matters/m999/draft-template`,
        withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ templateId: "engagement_letter", content: "x" }) }),
      )
    ).json();

    const reviseRes = await fetch(
      `${baseUrl}/api/drafting/matters/m999/work-products/${created.id}/revise`,
      withCookie(paralegalCookie, { method: "POST", body: JSON.stringify({ content: "hijacked" }) }),
    );
    expect(reviseRes.status).toBe(403);
  });

  it("returns 404 for an unknown work-product id on an accessible matter", async () => {
    const res = await fetch(`${baseUrl}/api/drafting/matters/m1/work-products/nope`, withCookie(paralegalCookie));
    expect(res.status).toBe(404);
  });
});
