import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createReviewServer } from "../src/review-ui/server.js";
import { ReviewGateService } from "../src/review-ui/review-service.js";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { WorkProductStore } from "../src/core/work-product-store.js";
import { AuthService, LOGIN_ROLES, type User, type UserRole } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";

/**
 * Account creation stored whatever it was sent. An attorney could mint a
 * password login with role "system" — the integrations' machine
 * credential — or give a new account a colleague's actor id, which read
 * that colleague's direct messages and was recorded as them.
 */
const base = { password: "correct-horse" };

function seeded(): AuthService {
  const auth = new AuthService();
  auth.createUser({ ...base, username: "attorney1", role: "attorney", actorId: "a1" });
  auth.createUser({ ...base, username: "paralegal1", role: "paralegal", actorId: "p1" });
  return auth;
}

/** What a state file written before these checks can hold. */
function withLegacyUser(auth: AuthService, change: (user: User) => User): AuthService {
  const snapshot = auth.toSnapshot();
  snapshot.users = snapshot.users.map((u) => (u.username === "paralegal1" ? change(u) : u));
  return AuthService.fromSnapshot(snapshot);
}

describe("who an account can be", () => {
  it("only signs people in as a person", () => {
    const auth = seeded();
    for (const role of ["system", "anonymous", "superuser", "Attorney", ""]) {
      expect(() => auth.createUser({ ...base, username: `u_${role || "blank"}`, role: role as UserRole }), role).toThrow(
        /role must be attorney, paralegal, receptionist, staff or client/,
      );
    }
    for (const role of LOGIN_ROLES) {
      expect(auth.createUser({ ...base, username: `ok_${role}`, role }).role).toBe(role);
    }
  });

  it("gives every account its own actor id", () => {
    const auth = seeded();
    expect(() => auth.createUser({ ...base, username: "twin", role: "receptionist", actorId: "p1" })).toThrow(
      /already belongs to another account/,
    );
    expect(() => auth.createUser({ ...base, username: "twin", role: "receptionist", actorId: " P1 " })).toThrow(
      /already belongs/,
    );
    // A username is the default actor id, so it collides the same way.
    expect(() => auth.createUser({ ...base, username: "a1", role: "paralegal" })).toThrow(/already belongs/);
    for (const reserved of ["calendar-integration", "system", "public-booking-form", "anonymous"]) {
      expect(() => auth.createUser({ ...base, username: `r${reserved.length}`, role: "staff", actorId: reserved })).toThrow(
        /reserved for the server/,
      );
    }
  });

  it("refuses a username that isn't one word on one line, and stores it trimmed", () => {
    const auth = seeded();
    for (const username of ["bad name", "bad\nname", "x".repeat(65)]) {
      expect(() => auth.createUser({ ...base, username, role: "staff" }), JSON.stringify(username)).toThrow(/one word/);
    }
    const user = auth.createUser({ ...base, username: "  dana  ", role: "staff" });
    expect(user.username).toBe("dana");
    expect(user.actorId).toBe("dana");
  });

  it("checks the contact details it will mail and text", () => {
    const auth = seeded();
    expect(() => auth.createUser({ ...base, username: "e1", role: "staff", email: "not-an-email" })).toThrow(
      /doesn't look like an email address/,
    );
    expect(() => auth.createUser({ ...base, username: "e2", role: "staff", email: "a@b.com\r\nBcc: x@y.com" })).toThrow(
      /email address/,
    );
    expect(() => auth.createUser({ ...base, username: "e3", role: "staff", phone: "call me" })).toThrow(/phone number/);
    expect(() => auth.createUser({ ...base, username: "e4", role: "staff", displayName: "x".repeat(121) })).toThrow(
      /at most 120/,
    );
    const user = auth.createUser({ ...base, username: "e5", role: "staff", email: " dana@firm.example ", phone: "+1 (555) 010-2000" });
    expect(user.email).toBe("dana@firm.example");
    expect(() => auth.setEmail(user.id, "nope")).toThrow(/email address/);
    expect(auth.setEmail(user.id, "").email).toBeUndefined();
  });
});

describe("records saved before these checks", () => {
  it("can't sign in as the machine credential, or keep a session as it", () => {
    const original = seeded();
    const session = original.login("paralegal1", "correct-horse", false);
    const auth = withLegacyUser(original, (u) => ({ ...u, role: "system" as UserRole }));
    expect(auth.actorForToken(session.token)).toBeUndefined();
    expect(auth.userForToken(session.token)).toBeUndefined();
    expect(() => auth.login("paralegal1", "correct-horse", false)).toThrow(/invalid username or password/);
    expect(auth.requestPasswordReset("paralegal1")).toBeUndefined();
    // Still listed, so an attorney can find it and disable it.
    expect(auth.listUsers().some((u) => u.username === "paralegal1")).toBe(true);
  });

  it("can't sign in under a role that names nothing", () => {
    const auth = withLegacyUser(seeded(), (u) => ({ ...u, role: "superuser" as UserRole }));
    expect(() => auth.login("paralegal1", "correct-horse", false)).toThrow(/invalid username or password/);
  });

  it("lets only the first account holding an actor id sign in as it", () => {
    const auth = withLegacyUser(seeded(), (u) => ({ ...u, actorId: "A1" }));
    expect(() => auth.login("paralegal1", "correct-horse", false)).toThrow(/invalid username or password/);
    expect(auth.actorForToken(auth.login("attorney1", "correct-horse", false).token)).toEqual({ id: "a1", role: "attorney" });
  });
});

describe("accounts HTTP API: the holes as they were reached", () => {
  let server: Server;
  let baseUrl: string;
  let auth: AuthService;

  async function login(username: string): Promise<Response> {
    return fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "correct-horse" }),
    });
  }

  async function create(cookie: string, body: object): Promise<Response> {
    return fetch(`${baseUrl}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ password: "correct-horse", ...body }),
    });
  }

  beforeEach(async () => {
    auth = seeded();
    const accounts = new AccountsService(auth, new AccessControl(new AuditLog()));
    server = createReviewServer(new ReviewGateService(new WorkProductStore()), auth, { accounts });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses to mint a system login, so an attorney can't confirm a deadline as the calendar", async () => {
    const cookie = (await login("attorney1")).headers.get("set-cookie")!.split(";")[0]!;
    const res = await create(cookie, { username: "calendar", role: "system" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/role must be/);
    expect((await login("calendar")).status).toBe(401);
  });

  it("refuses a second account under a colleague's actor id", async () => {
    const cookie = (await login("attorney1")).headers.get("set-cookie")!.split(";")[0]!;
    const res = await create(cookie, { username: "twin", role: "receptionist", actorId: "p1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already belongs to another account/);
    // The attorney is still signed in: a refusal here isn't a sign-in failure.
    expect((await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});

describe("granting a client a matter", () => {
  it("is refused for a matter with no record, which would hand them whatever is opened under that number later", () => {
    const auth = new AuthService();
    auth.createUser({ username: "atty", password: "correct-horse", role: "attorney", actorId: "a1" });
    const carla = auth.createUser({ username: "carla", password: "correct-horse", role: "client", actorId: "c1" });
    const accessControl = new AccessControl(new AuditLog());
    const onRecord = new Set(["2026-0142"]);
    const accounts = new AccountsService(auth, accessControl, undefined, undefined, (id) => onRecord.has(id));
    const attorney = { id: "a1", role: "attorney" as const };

    expect(() => accounts.grantMatterAccess(attorney, carla.id, "2026-0143")).toThrow(
      /no matter '2026-0143' on record — create it on the Conflicts panel first/,
    );
    expect(accessControl.getClientMatterIds("c1")).toEqual([]);

    accounts.grantMatterAccess(attorney, carla.id, "2026-0142");
    expect(accessControl.getClientMatterIds("c1")).toEqual(["2026-0142"]);
    // Revoking never needs a record: a stale grant must always be removable.
    onRecord.clear();
    accounts.revokeMatterAccess(attorney, carla.id, "2026-0142");
    expect(accessControl.getClientMatterIds("c1")).toEqual([]);
  });
});
