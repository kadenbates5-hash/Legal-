import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { ClientMessagingService } from "../src/review-ui/client-messaging-service.js";
import { ClientMessageStore } from "../src/core/client-messages.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let clientCookie: string;
let attorneyCookie: string;
let paralegalCookie: string;

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

const get = (cookie: string, path: string) => fetch(`${baseUrl}${path}`, withCookie(cookie));
const post = (cookie: string, path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, withCookie(cookie, { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m1");
  accessControl.grantClientAccess("c1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "client1", password: "correct-horse", role: "client", actorId: "c1" });
  auth.createUser({ username: "client2", password: "correct-horse", role: "client", actorId: "c2" });

  const clientMessaging = new ClientMessagingService({ store: new ClientMessageStore(), accessControl, auditLog });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { clientMessaging, auditLog });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  clientCookie = await loginCookie("client1");
  attorneyCookie = await loginCookie("attorney1");
  paralegalCookie = await loginCookie("paralegal1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("client messaging HTTP API", () => {
  it("404s when client messaging isn't configured", async () => {
    const auth = new AuthService();
    auth.createUser({ username: "a", password: "correct-horse", role: "attorney" });
    const bareServer = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {});
    await new Promise<void>((resolve) => bareServer.listen(0, resolve));
    const { port } = bareServer.address() as AddressInfo;
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "a", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`http://127.0.0.1:${port}/api/client-messages/matters/m1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
  });

  it("lets a client post, and staff see and reply on the same thread", async () => {
    const posted = await post(clientCookie, "/api/client-messages/matters/m1", { body: "When is my hearing?" });
    expect(posted.status).toBe(200);

    const staffView = await get(paralegalCookie, "/api/client-messages/matters/m1");
    expect(staffView.status).toBe(200);
    expect(await staffView.json()).toMatchObject([{ authorRole: "client", body: "When is my hearing?" }]);

    const reply = await post(paralegalCookie, "/api/client-messages/matters/m1", { body: "Next Tuesday at 9am." });
    expect(reply.status).toBe(200);

    const clientView = (await (await get(clientCookie, "/api/client-messages/matters/m1")).json()) as Array<{ body: string }>;
    expect(clientView.map((m) => m.body)).toEqual(["When is my hearing?", "Next Tuesday at 9am."]);
  });

  it("denies a client account that wasn't granted this matter", async () => {
    const otherCookie = await loginCookie("client2");
    expect((await get(otherCookie, "/api/client-messages/matters/m1")).status).toBe(403);
    expect((await post(otherCookie, "/api/client-messages/matters/m1", { body: "hi" })).status).toBe(403);
  });

  it("denies a paralegal not assigned to the matter", async () => {
    expect((await get(paralegalCookie, "/api/client-messages/matters/m2")).status).toBe(403);
  });

  it("lets an attorney reach any matter's thread", async () => {
    await post(clientCookie, "/api/client-messages/matters/m1", { body: "hi" });
    expect((await get(attorneyCookie, "/api/client-messages/matters/m1")).status).toBe(200);
  });
});
