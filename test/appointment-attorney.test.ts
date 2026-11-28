import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SchedulingError, SchedulingService } from "../src/core/scheduling.js";
import { AuthService } from "../src/core/auth.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { createReviewServer } from "../src/review-ui/server.js";
import type { FirmConfig } from "../src/config/firm-config.js";
import type { Actor } from "../src/core/types.js";

/**
 * An appointment that names an attorney used to take any string: a typo,
 * an id the Assistant invented, someone who left. Nobody would attend,
 * the client's reminder named "jdoe", and the real attorney's calendar
 * was never checked for a clash.
 */
const receptionist: Actor = { id: "r1", role: "receptionist" };
const at = (iso: string) => new Date(iso);

function service(firmConfig?: FirmConfig) {
  const auth = new AuthService();
  auth.createUser({ username: "ada", password: "correct-horse", role: "attorney", actorId: "a1" });
  const ben = auth.createUser({ username: "ben", password: "correct-horse", role: "attorney", actorId: "a2" });
  auth.createUser({ username: "pat", password: "correct-horse", role: "paralegal", actorId: "p1" });
  auth.setDisabled(ben.id, true); // left the firm
  const scheduling = new SchedulingService(firmConfig ? { firmConfig } : {});
  scheduling.setAttorneyDirectory((id) => auth.listUsers().some((u) => u.actorId === id && u.role === "attorney" && !u.disabled));
  return scheduling;
}

describe("booking with a named attorney", () => {
  it("takes an attorney who works here", () => {
    expect(service().scheduleConsultation(receptionist, { matterId: "m1", startTime: at("2026-12-02T15:00:00Z"), attorneyId: "a1" }).attorneyId).toBe("a1");
  });

  it("refuses anyone else, as a plain mistake", () => {
    const s = service();
    for (const attorneyId of ["nobody", "A1 ", "p1", "a2", "<b>x</b>"]) {
      let error: unknown;
      try {
        s.scheduleConsultation(receptionist, { matterId: "m1", startTime: at("2026-12-02T15:00:00Z"), attorneyId });
      } catch (err) {
        error = err;
      }
      expect(error, attorneyId).toBeInstanceOf(SchedulingError);
      expect((error as SchedulingError).kind).toBe("invalid");
      expect((error as Error).message).toMatch(/isn't an attorney at this firm/);
    }
    expect(s.listAll({ id: "a1", role: "attorney" })).toHaveLength(0);
  });

  it("takes an attorney the firm config lists, and still auto-assigns", () => {
    const firm: FirmConfig = {
      firmName: "Reyes & Okafor",
      attorneys: [{ id: "counsel-7", name: "Of counsel", practiceAreaIds: ["criminal-law"] }],
      businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
      branding: { tone: "warm", greeting: "Hello." },
      jurisdictionRecordingConsent: "one-party-consent",
    };
    const s = service(firm);
    expect(s.scheduleConsultation(receptionist, { matterId: "m1", startTime: at("2026-12-02T15:00:00Z"), attorneyId: "counsel-7" }).attorneyId).toBe("counsel-7");
    expect(s.scheduleConsultation(receptionist, { matterId: "m1", startTime: at("2026-12-03T15:00:00Z"), practiceAreaId: "criminal-law" }).attorneyId).toBe("counsel-7");
  });

  it("is unchecked where no directory was given, as before", () => {
    expect(new SchedulingService().scheduleConsultation(receptionist, { matterId: "m1", startTime: at("2026-12-02T15:00:00Z"), attorneyId: "anyone" }).attorneyId).toBe("anyone");
  });
});

describe("over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;

  beforeEach(async () => {
    const auth = new AuthService();
    auth.createUser({ username: "ada", password: "correct-horse", role: "attorney", actorId: "a1" });
    const scheduling = new SchedulingService();
    scheduling.setAttorneyDirectory((id) => auth.listUsers().some((u) => u.actorId === id && u.role === "attorney"));
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { scheduling });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "correct-horse" }),
    });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const book = (attorneyId: string) =>
    fetch(`${baseUrl}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ matterId: "m1", startTime: "2026-12-02T15:00:00Z", attorneyId }),
    });

  it("is a 400 naming the problem, and a real attorney books", async () => {
    const bad = await book("jdoe");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/"jdoe" isn't an attorney at this firm/);
    expect((await book("a1")).status).toBe(200);
  });
});
