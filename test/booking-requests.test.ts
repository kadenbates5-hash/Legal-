import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  BOOKING_MAX_PENDING,
  BookingRequestError,
  BookingRequestStore,
  SubmissionLimiter,
  validateBookingSubmission,
  type BookingSubmission,
} from "../src/core/booking-requests.js";
import { BookingService } from "../src/review-ui/booking-service.js";
import { SchedulingService } from "../src/core/scheduling.js";
import { AuditLog } from "../src/core/audit.js";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker } from "../src/core/conflicts.js";
import { AuthService } from "../src/core/auth.js";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";
import type { FirmConfig } from "../src/config/firm-config.js";

const NOW = new Date(2026, 10, 23, 10, 0, 0);
const attorney: Actor = { id: "a1", role: "attorney" };
const receptionist: Actor = { id: "r1", role: "receptionist" };
const client: Actor = { id: "c1", role: "client" };

const firm: FirmConfig = {
  firmName: "Brooks & Lee",
  attorneys: [{ id: "a1", name: "Ada Brooks", practiceAreaIds: ["criminal-law"] }],
  businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
  branding: { tone: "warm", greeting: "Hi." },
  jurisdictionRecordingConsent: "two-party-consent",
  letterhead: { phone: "555-0100" },
};

const valid: BookingSubmission = {
  name: "Pat Lee",
  email: "pat@example.com",
  matterType: "dui",
  preferredDate: "2026-11-26",
  preferredTime: "morning",
};

function conflictChecker() {
  const matters = new MatterStore();
  matters.upsert("m-1", {
    title: "State v. Smith",
    status: "open",
    parties: [
      { name: "Jordan Smith", role: "client", note: undefined },
      { name: "State of Example", role: "adverse", note: undefined },
    ],
  });
  return new ConflictChecker(matters);
}

describe("validateBookingSubmission", () => {
  it("accepts a well-formed request and trims it", () => {
    const result = validateBookingSubmission({ ...valid, name: "  Pat   Lee " }, NOW);
    expect(result.name).toBe("Pat Lee");
    expect(result.matterType).toBe("dui");
  });

  it.each([
    ["no name", { ...valid, name: "" }],
    ["markup in the name", { ...valid, name: "<script>alert(1)</script>" }],
    ["a link instead of a name", { ...valid, name: "http://spam.example" }],
    ["no way to reach them", { ...valid, email: "", phone: "" }],
    ["a malformed email", { ...valid, email: "not-an-email" }],
    ["a malformed phone", { ...valid, email: "", phone: "call me maybe" }],
    ["an unknown matter type", { ...valid, matterType: "murder_for_hire" }],
    ["a day in the past", { ...valid, preferredDate: "2026-11-01" }],
    ["a day too far ahead", { ...valid, preferredDate: "2027-06-01" }],
    ["an unknown time of day", { ...valid, preferredTime: "midnight" }],
    ["a narrative in the other-party field", { ...valid, otherPartyName: "He hit my car at 5pm" }],
  ])("rejects %s", (_label, input) => {
    expect(() => validateBookingSubmission(input, NOW)).toThrow(BookingRequestError);
  });
});

describe("BookingRequestStore", () => {
  it("screens the other party against every matter, flagging a request adverse to a current client", () => {
    const store = new BookingRequestStore();
    const request = store.submit({ ...valid, otherPartyName: "Jordan Smith" }, { conflictChecker: conflictChecker(), now: NOW });
    expect(request.status).toBe("pending");
    expect(request.conflict.requiresAttorneyReview).toBe(true);
    expect(request.conflict.hits[0]?.matterId).toBe("m-1");
  });

  it("stops taking requests when too many are waiting, rather than burying real ones", () => {
    const store = new BookingRequestStore();
    for (let i = 0; i < BOOKING_MAX_PENDING; i += 1) store.submit({ ...valid, name: `Pat Lee` }, { now: NOW });
    expect(() => store.submit(valid, { now: NOW })).toThrow(/call the office/);
  });

  it("decides a request once, and round-trips through a snapshot", () => {
    const store = new BookingRequestStore();
    const request = store.submit(valid, { now: NOW });
    store.markDeclined(request.id, "r1", "duplicate", NOW);
    expect(() => store.markAccepted(request.id, "a1", "appt_1", NOW)).toThrow(/already declined/);
    const copy = BookingRequestStore.fromSnapshot(store.toSnapshot());
    expect(copy.get(request.id)).toMatchObject({ status: "declined", declineReason: "duplicate" });
  });
});

describe("SubmissionLimiter", () => {
  it("allows a few submissions per window, then says not now, then recovers", () => {
    let t = 0;
    const limiter = new SubmissionLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect([1, 2, 3].map(() => limiter.allow("ip"))).toEqual([true, true, true]);
    expect(limiter.allow("ip")).toBe(false);
    expect(limiter.allow("another-ip")).toBe(true);
    t = 1001;
    expect(limiter.allow("ip")).toBe(true);
  });
});

function makeService(options: { limiter?: SubmissionLimiter } = {}) {
  const store = new BookingRequestStore();
  const auditLog = new AuditLog();
  const scheduling = new SchedulingService({ firmConfig: firm });
  const service = new BookingService({
    store,
    scheduling,
    auditLog,
    conflictChecker: conflictChecker(),
    firmConfig: firm,
    now: () => NOW,
    ...(options.limiter ? { limiter: options.limiter } : {}),
  });
  return { store, auditLog, scheduling, service };
}

describe("BookingService", () => {
  it("tells the public what to show, and nothing about attorneys or matters", () => {
    const config = makeService().service.publicConfig();
    expect(config).toMatchObject({ firmName: "Brooks & Lee", phone: "555-0100" });
    expect(JSON.stringify(config)).not.toMatch(/a1|Ada|Smith/);
  });

  it("drops a honeypot submission silently: same answer, nothing stored, nothing logged", () => {
    const { service, store, auditLog } = makeService();
    expect(service.submitPublic(valid, { ip: "1.2.3.4", honeypot: "http://spam" })).toEqual({ received: true });
    expect(store.list()).toHaveLength(0);
    expect(auditLog.read("attorney")).toHaveLength(0);
  });

  it("never tells the requester what the conflicts check found", () => {
    const { service, store, auditLog } = makeService();
    const response = service.submitPublic({ ...valid, otherPartyName: "Jordan Smith" }, { ip: "1.2.3.4" });
    expect(response).toEqual({ received: true });
    expect(store.list()[0]?.conflict.requiresAttorneyReview).toBe(true);
    expect(auditLog.read("attorney").at(-1)?.action).toBe("booking_request_received");
  });

  it("rate-limits per connection", () => {
    const { service } = makeService({ limiter: new SubmissionLimiter({ max: 2 }) });
    service.submitPublic(valid, { ip: "9.9.9.9" });
    service.submitPublic(valid, { ip: "9.9.9.9" });
    expect(() => service.submitPublic(valid, { ip: "9.9.9.9" })).toThrow(/Too many requests/);
  });

  it("is for staff only", () => {
    const { service } = makeService();
    expect(() => service.list(client)).toThrow(AccessDeniedError);
    expect(service.list(receptionist)).toEqual([]);
  });

  it("books a real appointment on accept, under a prospective matter id", () => {
    const { service, store, scheduling } = makeService();
    service.submitPublic(valid, { ip: "1.2.3.4" });
    const id = store.list()[0]!.id;
    const accepted = service.accept(receptionist, id, { startTime: new Date("2026-11-26T10:00:00Z") });
    expect(accepted.status).toBe("accepted");
    const appointment = scheduling.get(receptionist, accepted.appointmentId!);
    expect(appointment?.matterId).toBe(`prospective-${id}`);
  });

  it("only lets an attorney accept a request the conflicts check flagged", () => {
    const { service, store } = makeService();
    service.submitPublic({ ...valid, otherPartyName: "Jordan Smith" }, { ip: "1.2.3.4" });
    const id = store.list()[0]!.id;
    expect(() => service.accept(receptionist, id, { startTime: new Date("2026-11-26T10:00:00Z") })).toThrow(AccessDeniedError);
    expect(service.accept(attorney, id, { startTime: new Date("2026-11-26T10:00:00Z") }).status).toBe("accepted");
  });

  it("leaves a request pending when the booking itself is refused", () => {
    const { service, store } = makeService();
    service.submitPublic(valid, { ip: "1.2.3.4" });
    service.submitPublic({ ...valid, name: "Sam Ortiz" }, { ip: "1.2.3.5" });
    const [first, second] = store.list();
    service.accept(attorney, first!.id, { startTime: new Date("2026-11-26T10:00:00Z") });
    expect(() => service.accept(attorney, second!.id, { startTime: new Date("2026-11-26T10:00:00Z") })).toThrow(/overlapping/);
    expect(store.get(second!.id).status).toBe("pending");
  });

  it("records a decline with its reason", () => {
    const { service, store, auditLog } = makeService();
    service.submitPublic(valid, { ip: "1.2.3.4" });
    const id = store.list()[0]!.id;
    expect(service.decline(receptionist, id, "duplicate of a phone booking").declineReason).toBe("duplicate of a phone booking");
    expect(auditLog.read("attorney").at(-1)?.action).toBe("booking_request_declined");
  });
});

describe("booking over HTTP", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function boot(withBooking: boolean) {
    const auth = new AuthService();
    auth.createUser({ username: "reception1", password: "correct-horse", role: "receptionist", actorId: "r1" });
    const { service } = makeService();
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, withBooking ? { booking: service } : {});
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reception1", password: "correct-horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return { baseUrl, cookie };
  }

  it("404s both sides when online booking isn't turned on", async () => {
    const { baseUrl, cookie } = await boot(false);
    expect((await fetch(`${baseUrl}/api/public/booking/config`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/booking-requests`, { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("takes a public request with no session and shows it to staff", async () => {
    const { baseUrl, cookie } = await boot(true);
    const config = await (await fetch(`${baseUrl}/api/public/booking/config`)).json();
    expect(config.matterTypes.length).toBeGreaterThan(0);

    const submitted = await fetch(`${baseUrl}/api/public/booking/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...valid, otherPartyName: "Jordan Smith" }),
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toEqual({ received: true });

    const bad = await fetch(`${baseUrl}/api/public/booking/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...valid, name: "" }),
    });
    expect(bad.status).toBe(400);

    const staffList = await (await fetch(`${baseUrl}/api/booking-requests`, { headers: { Cookie: cookie } })).json();
    expect(staffList).toHaveLength(1);
    expect(staffList[0].conflict.requiresAttorneyReview).toBe(true);

    const refused = await fetch(`${baseUrl}/api/booking-requests/${staffList[0].id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ startTime: "2026-11-26T10:00:00Z" }),
    });
    expect(refused.status).toBe(403);
  });

  it("requires a session for the staff routes", async () => {
    const { baseUrl } = await boot(true);
    expect((await fetch(`${baseUrl}/api/booking-requests`)).status).toBe(401);
  });
});

describe("what the booking form says back", () => {
  const valid = { name: "Pat Lee", email: "pat@example.com", matterType: "dui", preferredDate: "2026-11-30", preferredTime: "morning" };

  it("names the box that's too long", () => {
    expect(() => validateBookingSubmission({ ...valid, name: `Pat ${"x".repeat(200)}` }, NOW)).toThrow(/^Your name can be at most 100 characters\.$/);
    expect(() => validateBookingSubmission({ ...valid, otherPartyName: "y".repeat(200) }, NOW)).toThrow(/other party's name can be at most 120/);
  });

  it("refuses a day that doesn't exist, even one that sorts inside the window", () => {
    expect(() => validateBookingSubmission({ ...valid, preferredDate: "2026-11-31" }, NOW)).toThrow(/Please choose a day/);
    expect(validateBookingSubmission(valid, NOW).preferredDate).toBe("2026-11-30");
  });
});
