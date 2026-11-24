import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer, type ReviewServerOptions } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService } from "../src/core/auth.js";
import type { AssistantService } from "../src/review-ui/assistant-service.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function start(options: ReviewServerOptions = {}) {
  const auth = new AuthService();
  for (const [username, role] of [["atty", "attorney"], ["para", "paralegal"], ["recep", "receptionist"], ["cli", "client"]] as const) {
    auth.createUser({ username, password: "correct-horse", role, actorId: username });
  }
  server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, options);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const cookieFor = async (username: string) => {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "correct-horse" }),
    });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { base, cookieFor };
}

describe("GET /api/capabilities", () => {
  it("tells staff which optional features this server has — booleans only", async () => {
    const { base, cookieFor } = await start();
    for (const user of ["atty", "para", "recep"]) {
      const res = await fetch(`${base}/api/capabilities`, { headers: { Cookie: await cookieFor(user) } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        assistant: false,
        esignature: false,
        publicBooking: false,
        speech: false,
        calendarConnection: false,
      });
    }
  });

  it("reports a feature the server was given", async () => {
    // Only its presence matters to the probe.
    const { base, cookieFor } = await start({ assistant: {} as AssistantService });
    const body = await (await fetch(`${base}/api/capabilities`, { headers: { Cookie: await cookieFor("atty") } })).json();
    expect(body.assistant).toBe(true);
  });

  it("is for staff: a client is refused, and no session is a 401", async () => {
    const { base, cookieFor } = await start();
    expect((await fetch(`${base}/api/capabilities`, { headers: { Cookie: await cookieFor("cli") } })).status).toBe(403);
    expect((await fetch(`${base}/api/capabilities`)).status).toBe(401);
  });
});
