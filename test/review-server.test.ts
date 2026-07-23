import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { WorkProduct } from "../src/core/review-gate.js";
import { AuditLog } from "../src/core/audit.js";

let server: Server;
let baseUrl: string;
let store: WorkProductStore;

const attorneyHeaders = { "x-actor-id": "a1", "x-actor-role": "attorney", "Content-Type": "application/json" };
const paralegalHeaders = { "x-actor-id": "p1", "x-actor-role": "paralegal", "Content-Type": "application/json" };

beforeEach(async () => {
  store = new WorkProductStore();
  const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "draft text" }, new AuditLog());
  wp.submitForReview({ id: "p1", role: "paralegal" });
  store.register(wp);

  const service = new ReviewGateService(store);
  server = createReviewServer(service);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("review-gate HTTP API", () => {
  it("serves the static dashboard at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Attorney Review Queue");
  });

  it("lists pending-review work product for an attorney", async () => {
    const res = await fetch(`${baseUrl}/api/work-products?status=pending_review`, { headers: attorneyHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("wp1");
  });

  it("denies a paralegal actor with 403, not a silent empty list", async () => {
    const res = await fetch(`${baseUrl}/api/work-products`, { headers: paralegalHeaders });
    expect(res.status).toBe(403);
  });

  it("gets work-product detail including content", async () => {
    const res = await fetch(`${baseUrl}/api/work-products/wp1`, { headers: attorneyHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("draft text");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/work-products/nope`, { headers: attorneyHeaders });
    expect(res.status).toBe(404);
  });

  it("approves then releases a work product end to end", async () => {
    const approveRes = await fetch(`${baseUrl}/api/work-products/wp1/approve`, {
      method: "POST",
      headers: attorneyHeaders,
      body: "{}",
    });
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).status).toBe("approved");

    const releaseRes = await fetch(`${baseUrl}/api/work-products/wp1/release`, {
      method: "POST",
      headers: attorneyHeaders,
      body: "{}",
    });
    expect(releaseRes.status).toBe(200);
    expect((await releaseRes.json()).status).toBe("released");
  });

  it("returns 409 for an invalid state transition (release before approval)", async () => {
    const res = await fetch(`${baseUrl}/api/work-products/wp1/release`, {
      method: "POST",
      headers: attorneyHeaders,
      body: "{}",
    });
    expect(res.status).toBe(409);
  });

  it("rejects a work product with a reason", async () => {
    const res = await fetch(`${baseUrl}/api/work-products/wp1/reject`, {
      method: "POST",
      headers: attorneyHeaders,
      body: JSON.stringify({ reason: "not viable" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rejected");
  });

  it("clears a flag by name", async () => {
    store.get("wp1")!.addFlag("padilla_advisory_required");
    const res = await fetch(`${baseUrl}/api/work-products/wp1/clear-flag`, {
      method: "POST",
      headers: attorneyHeaders,
      body: JSON.stringify({ flag: "padilla_advisory_required" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).not.toContain("padilla_advisory_required");
  });
});

describe("review-gate HTTP API persistence hook", () => {
  it("fires onMutated after a successful mutation but not on a plain read", async () => {
    const auditLog = new AuditLog();
    const hookStore = new WorkProductStore();
    const wp = new WorkProduct({ id: "wp1", matterId: "m1", kind: "engagement_letter", content: "x" }, auditLog);
    wp.submitForReview({ id: "p1", role: "paralegal" });
    hookStore.register(wp);

    let mutationCount = 0;
    const hookServer = createReviewServer(new ReviewGateService(hookStore), () => {
      mutationCount += 1;
    });
    await new Promise<void>((resolve) => hookServer.listen(0, resolve));
    const { port } = hookServer.address() as AddressInfo;
    const hookBaseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${hookBaseUrl}/api/work-products/wp1`, { headers: attorneyHeaders });
    expect(mutationCount).toBe(0);

    await fetch(`${hookBaseUrl}/api/work-products/wp1/approve`, {
      method: "POST",
      headers: attorneyHeaders,
      body: "{}",
    });
    expect(mutationCount).toBe(1);

    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
  });
});
