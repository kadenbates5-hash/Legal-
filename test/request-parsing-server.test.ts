import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { DocumentsService } from "../src/review-ui/documents-service.js";
import { CasesService } from "../src/review-ui/cases-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AuthService } from "../src/core/auth.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { DocumentStore } from "../src/core/document-store.js";

/**
 * The dashboard puts ids into URLs with encodeURIComponent. Before path
 * segments were decoded, a matter typed as "Ruiz 2026" was stored as
 * "Ruiz%202026" by every route taking its id from the path — and the Cases
 * panel, encoding that stored id again, opened an empty matter.
 */
describe("reading a request: ids in the path, cookies, bodies", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function start() {
    const accessControl = new AccessControl(new AuditLog());
    const documentStore = new DocumentStore();
    const documents = new DocumentsService({ accessControl, store: documentStore });
    const cases = new CasesService({ accessControl, workProductStore: new WorkProductStore(), documentStore });
    const auth = new AuthService();
    auth.createUser({ username: "atty", password: "correct-horse", role: "attorney", actorId: "a1" });
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { documents, cases });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "atty", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return { base, cookie, documentStore };
  }

  it("takes a large body only from someone signed in", async () => {
    const { base, cookie, documentStore } = await start();
    const big = "A".repeat(2 * 1024 * 1024);
    // Routes that need no sign-in used to buffer ~34 MB for anyone.
    // (The signer and webhook routes 404 here before reading anything: this
    // server has neither configured. Their limit is the same one.)
    for (const path of ["/api/login", "/api/forgot-password", "/api/reset-password/confirm", "/api/login/passkey/begin"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "atty", password: big }),
      });
      expect(res.status, path).toBe(413);
    }
    // The same size from a signed-in attorney is an ordinary upload.
    const upload = await fetch(`${base}/api/documents/matters/m1`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "scan.pdf", contentType: "application/pdf", content: Buffer.from(big).toString("base64") }),
    });
    expect(upload.status).toBe(200);
    expect(documentStore.listByMatter("m1")).toHaveLength(1);
  });

  it("stores a matter id with a space as typed, and the Cases panel can open it", async () => {
    const { base, cookie, documentStore } = await start();
    const matterId = "Ruiz 2026 / appeal ñ";
    const upload = await fetch(`${base}/api/documents/matters/${encodeURIComponent(matterId)}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "a.txt", contentType: "text/plain", content: "aGk=" }),
    });
    expect(upload.status).toBe(200);
    expect((await upload.json()).matterId).toBe(matterId);
    expect(documentStore.listByMatter(matterId)).toHaveLength(1);

    const list = await (await fetch(`${base}/api/cases`, { headers: { Cookie: cookie } })).json();
    const listed = list.find((c: { matterId: string }) => c.matterId === matterId);
    expect(listed).toBeDefined();
    // What clicking the listed case fetches.
    const opened = await (await fetch(`${base}/api/cases/${encodeURIComponent(listed.matterId)}`, { headers: { Cookie: cookie } })).json();
    expect(opened.documents).toHaveLength(1);
  });

  it("still reaches a matter stored percent-encoded before the fix", async () => {
    const { base, cookie, documentStore } = await start();
    documentStore.upload({ matterId: "Ruiz%202026", fileName: "old.txt", contentType: "text/plain", content: "", uploadedBy: "a1" });
    const opened = await (await fetch(`${base}/api/cases/${encodeURIComponent("Ruiz%202026")}`, { headers: { Cookie: cookie } })).json();
    expect(opened.documents).toHaveLength(1);
  });

  it("treats a malformed escape as an id that matches nothing, not an error", async () => {
    const { base, cookie } = await start();
    const res = await fetch(`${base}/api/cases/100%25off%E0`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toEqual([]);
  });

  it("refuses a JSON body that isn't an object, rather than reading fields off null", async () => {
    const { base, cookie } = await start();
    for (const body of ["null", "[]", '"x"', "7"]) {
      const res = await fetch(`${base}/api/documents/matters/m1`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body,
      });
      expect(res.status, body).toBe(400);
      expect((await res.json()).error, body).toBe("the request body must be a JSON object");
    }
  });

  it("isn't knocked over by someone else's cookie with a raw % in it", async () => {
    const { base, cookie } = await start();
    const res = await fetch(`${base}/api/me`, { headers: { Cookie: `promo=50%off; ${cookie}` } });
    expect(res.status).toBe(200);
  });
});
