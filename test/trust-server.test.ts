import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { TrustService } from "../src/review-ui/trust-service.js";
import { TrustLedger } from "../src/core/trust-ledger.js";
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
let ledger: TrustLedger;

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

const post = (cookie: string, path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, withCookie(cookie, { method: "POST", body: JSON.stringify(body) }));

beforeEach(async () => {
  auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  accessControl.assignParalegal("p1", "m-1");
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });

  ledger = new TrustLedger();
  const trust = new TrustService({ ledger, accessControl, auditLog });
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { trust, auditLog });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  attorneyCookie = await loginCookie("attorney1");
  paralegalCookie = await loginCookie("paralegal1");
  receptionCookie = await loginCookie("reception1");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("trust HTTP API", () => {
  it("404s when trust accounting isn't configured", async () => {
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
    expect((await fetch(`${url}/api/trust/matters/m-1`, withCookie(cookie))).status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("denies receptionists entirely", async () => {
    expect((await fetch(`${baseUrl}/api/trust/matters/m-1`, withCookie(receptionCookie))).status).toBe(403);
  });

  it("scopes the ledger to the paralegal's own matter", async () => {
    expect((await fetch(`${baseUrl}/api/trust/matters/m-1`, withCookie(paralegalCookie))).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/trust/matters/m-other`, withCookie(paralegalCookie))).status).toBe(403);
  });

  it("lets a paralegal record an incoming deposit", async () => {
    const res = await post(paralegalCookie, "/api/trust/matters/m-1", {
      type: "deposit",
      amountCents: 500_00,
      description: "Initial retainer",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).balanceAfterCents).toBe(500_00);
  });

  it("refuses to let a paralegal move money out of trust", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-1", { type: "deposit", amountCents: 500_00, description: "Retainer" });
    for (const type of ["disbursement", "earned_fee_transfer", "refund"]) {
      const res = await post(paralegalCookie, "/api/trust/matters/m-1", {
        type,
        amountCents: 1_00,
        description: "x",
      });
      expect(res.status).toBe(403);
    }
    // ...and the balance is untouched by the refused attempts.
    const view = await (await fetch(`${baseUrl}/api/trust/matters/m-1`, withCookie(paralegalCookie))).json();
    expect(view.balanceCents).toBe(500_00);
  });

  it("rejects an overdraw with 409, not a generic 400", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-1", { type: "deposit", amountCents: 100_00, description: "Retainer" });
    const res = await post(attorneyCookie, "/api/trust/matters/m-1", {
      type: "disbursement",
      amountCents: 100_01,
      description: "Too much",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/overdraw/i);
  });

  it("reverses an entry, keeping both the mistake and the correction", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-1", { type: "deposit", amountCents: 500_00, description: "Retainer" });
    const mistake = await (
      await post(attorneyCookie, "/api/trust/matters/m-1", { type: "disbursement", amountCents: 50_00, description: "Wrong payee" })
    ).json();

    const res = await post(attorneyCookie, `/api/trust/matters/m-1/${mistake.id}/reverse`, { reason: "wrong vendor" });
    expect(res.status).toBe(200);

    const view = await (await fetch(`${baseUrl}/api/trust/matters/m-1`, withCookie(attorneyCookie))).json();
    expect(view.balanceCents).toBe(500_00);
    expect(view.entries).toHaveLength(3);
  });

  it("will not reverse an entry belonging to a different matter", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-other", { type: "deposit", amountCents: 10_00, description: "Other" });
    const other = ledger.listForMatter("m-other")[0]!;
    const res = await post(attorneyCookie, `/api/trust/matters/m-1/${other.id}/reverse`, { reason: "nope" });
    expect(res.status).toBe(404);
  });

  it("keeps reconciliation attorney-only and reports an exact difference", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-1", { type: "deposit", amountCents: 500_00, description: "Retainer" });

    expect((await post(paralegalCookie, "/api/trust/reconcile", { bankBalanceCents: 500_00 })).status).toBe(403);

    const res = await post(attorneyCookie, "/api/trust/reconcile", { bankBalanceCents: 499_99 });
    const result = await res.json();
    expect(result.balanced).toBe(false);
    expect(result.differenceCents).toBe(-1);
  });

  it("audits every movement of client funds and every reconciliation", async () => {
    await post(attorneyCookie, "/api/trust/matters/m-1", { type: "deposit", amountCents: 100_00, description: "Retainer" });
    await post(attorneyCookie, "/api/trust/reconcile", { bankBalanceCents: 100_00 });
    const actions = auditLog.read("attorney").map((e) => e.action);
    expect(actions).toContain("trust_entry_recorded");
    expect(actions).toContain("trust_reconciliation_run");
  });
});
