import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer, maxRequestBodyBytesFor } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DocumentsService, DEFAULT_MAX_UPLOAD_BYTES } from "../src/review-ui/documents-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";

let server: Server;
let baseUrl: string;
let cookie: string;

/** Small enough to keep the test fast, large enough to exercise both paths. */
const MAX_BODY = 4096;

async function loginCookie(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "paralegal1", password: "correct-horse" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function withCookie(c: string, init?: RequestInit): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}), Cookie: c } };
}

beforeEach(async () => {
  const accessControl = new AccessControl(new AuditLog());
  accessControl.assignParalegal("p1", "m1");
  const auth = new AuthService();
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1" });

  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, {
    documents: new DocumentsService({ accessControl, store: new DocumentStore() }),
    maxRequestBodyBytes: MAX_BODY,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await loginCookie();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("request body size limit", () => {
  it("derives a body ceiling that clears a base64-inflated max upload", () => {
    // A 25 MB file is ~33.3 MB once base64-encoded — the cap has to exceed
    // that, or the documented per-file limit could never actually be used.
    expect(maxRequestBodyBytesFor(DEFAULT_MAX_UPLOAD_BYTES)).toBeGreaterThan((DEFAULT_MAX_UPLOAD_BYTES * 4) / 3);
  });

  it("rejects an oversized body with 413 rather than buffering it", async () => {
    const res = await fetch(
      `${baseUrl}/api/documents/matters/m1`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "big.pdf", contentType: "application/pdf", content: "A".repeat(MAX_BODY * 2) }),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("still accepts a body under the limit", async () => {
    const res = await fetch(
      `${baseUrl}/api/documents/matters/m1`,
      withCookie(cookie, {
        method: "POST",
        body: JSON.stringify({ fileName: "small.pdf", contentType: "application/pdf", content: "aGVsbG8=" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("bounds unauthenticated routes too — an oversized login body is 413, not 400/401", async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "x".repeat(MAX_BODY * 2), password: "y" }),
    });
    expect(res.status).toBe(413);
  });

  it("enforces the cap when Content-Length is absent (chunked upload)", async () => {
    // A streamed body carries no Content-Length, so the early header check
    // can't fire — this exercises the byte counter inside readBodyBuffer.
    const chunk = "B".repeat(1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const res = await fetch(`${baseUrl}/api/documents/matters/m1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: stream,
      // @ts-expect-error -- Node's fetch requires this for a streaming request body.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});
