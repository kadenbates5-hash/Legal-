import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let attorneyCookie: string;
let paralegalCookie: string;
let receptionCookie: string;
let auditLog: AuditLog;
let store: MatterStore;

async function loginCookie(username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "correct-horse" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function withCookie(cookie: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: cookie } };
}

beforeEach(async () => {
  auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-owned");
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });

  store = new MatterStore();
  store.upsert("m-owned", {
    title: "State v. Ruiz",
    status: "open",
    parties: [
      { name: "Carlos Ruiz", role: "client", note: undefined },
      { name: "Acme Corp", role: "adverse", note: undefined },
    ],
  });
  store.upsert("m-other", {
    title: "Unrelated matter",
    status: "open",
    parties: [{ name: "Dana Vance", role: "client", note: undefined }],
  });

  const matters = new MattersService({
    store,
    checker: new ConflictChecker(store),
    accessControl,
    auditLog,
  });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { matters, auditLog });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1");
  paralegalCookie = await loginCookie("paralegal1");
  receptionCookie = await loginCookie("reception1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("matters HTTP API", () => {
  it("404s when matters aren't configured", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
    const bare = createReviewServer(new ReviewGateService(new WorkProductStore()), auth);
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attorney1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${url}/api/matters`, withCookie(cookie))).status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("denies receptionists", async () => {
    expect((await fetch(`${baseUrl}/api/matters`, withCookie(receptionCookie))).status).toBe(403);
  });

  it("scopes the matter list to what the caller can open", async () => {
    const attorneySees = await (await fetch(`${baseUrl}/api/matters`, withCookie(attorneyCookie))).json();
    const paralegalSees = await (await fetch(`${baseUrl}/api/matters`, withCookie(paralegalCookie))).json();
    expect(attorneySees.map((m: { matterId: string }) => m.matterId).sort()).toEqual(["m-other", "m-owned"]);
    expect(paralegalSees.map((m: { matterId: string }) => m.matterId)).toEqual(["m-owned"]);
  });

  it("lets an attorney edit a matter record but not a paralegal", async () => {
    const ok = await fetch(
      `${baseUrl}/api/matters/m-owned`,
      withCookie(attorneyCookie, { method: "PUT", body: JSON.stringify({ title: "Renamed" }) }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).title).toBe("Renamed");

    const denied = await fetch(
      `${baseUrl}/api/matters/m-owned`,
      withCookie(paralegalCookie, { method: "PUT", body: JSON.stringify({ title: "Nope" }) }),
    );
    expect(denied.status).toBe(403);
  });

  it("404s for a matter with no record", async () => {
    expect((await fetch(`${baseUrl}/api/matters/never-seen`, withCookie(attorneyCookie))).status).toBe(404);
  });
});

describe("conflicts HTTP API", () => {
  it("searches the whole firm even for a paralegal scoped to one matter (Rule 1.10)", async () => {
    // p1 can only open m-owned, but a conflicts check must still see m-other —
    // a screen limited to your own matters would report a false all-clear.
    const res = await fetch(
      `${baseUrl}/api/conflicts/check`,
      withCookie(paralegalCookie, {
        method: "POST",
        body: JSON.stringify({ names: ["Dana Vance"], roleByName: { "Dana Vance": "adverse" } }),
      }),
    );
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.hits.map((h: { matterId: string }) => h.matterId)).toContain("m-other");
    expect(result.requiresAttorneyReview).toBe(true);
  });

  it("flags taking on a party adverse to a current client", async () => {
    const res = await fetch(
      `${baseUrl}/api/conflicts/check`,
      withCookie(attorneyCookie, {
        method: "POST",
        body: JSON.stringify({ names: ["Carlos Ruiz"], roleByName: { "Carlos Ruiz": "adverse" } }),
      }),
    );
    const result = await res.json();
    expect(result.hits[0].severity).toBe("direct");
  });

  it("returns a clean result for an unknown party", async () => {
    const res = await fetch(
      `${baseUrl}/api/conflicts/check`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ names: ["Nobody At All"] }) }),
    );
    const result = await res.json();
    expect(result.hits).toHaveLength(0);
    expect(result.requiresAttorneyReview).toBe(false);
  });

  it("denies receptionists", async () => {
    const res = await fetch(
      `${baseUrl}/api/conflicts/check`,
      withCookie(receptionCookie, { method: "POST", body: JSON.stringify({ names: ["Carlos Ruiz"] }) }),
    );
    expect(res.status).toBe(403);
  });

  it("audits every check, so the firm can evidence that screening happened", async () => {
    await fetch(
      `${baseUrl}/api/conflicts/check`,
      withCookie(attorneyCookie, { method: "POST", body: JSON.stringify({ names: ["Carlos Ruiz"] }) }),
    );
    const entry = auditLog.read("attorney").find((e) => e.action === "conflict_check_run");
    expect(entry).toBeDefined();
    expect(entry!.actor.id).toBe("a1");
    expect(entry!.detail).toContain("Carlos Ruiz");
  });
});
