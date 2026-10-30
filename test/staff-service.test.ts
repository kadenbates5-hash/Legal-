import { describe, expect, it } from "vitest";
import { StaffService, initialsFor } from "../src/review-ui/staff-service.js";
import { AuthService } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };
const receptionist: Actor = { id: "r1", role: "receptionist" };
const system: Actor = { id: "system", role: "system" };

function makeStaff() {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1", displayName: "Ada Attorney" });
  auth.createUser({ username: "paralegal1", password: "correct-horse", role: "paralegal", actorId: "p1", displayName: "Pat Paralegal" });
  const accessControl = new AccessControl(new AuditLog());
  return { auth, accessControl, staff: new StaffService(auth, accessControl) };
}

describe("initialsFor", () => {
  it("takes first+last initial for a multi-word name", () => {
    expect(initialsFor("Jane Doe")).toBe("JD");
    expect(initialsFor("Mary Jane Watson")).toBe("MW");
  });

  it("takes the first two characters for a single word", () => {
    expect(initialsFor("attorney1")).toBe("AT");
  });

  it("falls back to '?' for an empty name", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});

describe("StaffService", () => {
  it("is available to every human role, not just attorneys", () => {
    const { staff } = makeStaff();
    expect(() => staff.list(attorney)).not.toThrow();
    expect(() => staff.list(paralegal)).not.toThrow();
    expect(() => staff.list(receptionist)).not.toThrow();
  });

  it("denies the system machine credential", () => {
    const { staff } = makeStaff();
    expect(() => staff.list(system)).toThrow(AccessDeniedError);
  });

  // The staff directory predates the client portal. "Every logged-in
  // human" meant every staff role — a client seeing the internal
  // directory (who's assigned to which matter) was never the intent.
  it("denies a client account", () => {
    const { staff } = makeStaff();
    expect(() => staff.list({ id: "c1", role: "client" })).toThrow(AccessDeniedError);
  });

  it("lists every account with displayName/initials and no password fields", () => {
    const { staff } = makeStaff();
    const list = staff.list(attorney);
    expect(list).toHaveLength(2);
    const attorneyEntry = list.find((m) => m.username === "attorney1")!;
    expect(attorneyEntry.displayName).toBe("Ada Attorney");
    expect(attorneyEntry.initials).toBe("AA");
    expect(attorneyEntry).not.toHaveProperty("passwordHash");
    expect(attorneyEntry).not.toHaveProperty("salt");
  });

  it("includes a paralegal's matter assignment when one exists", () => {
    const { staff, accessControl } = makeStaff();
    accessControl.assignParalegal("p1", "matter-1");
    const list = staff.list(attorney);
    const paralegalEntry = list.find((m) => m.username === "paralegal1")!;
    expect(paralegalEntry.matterAssignment).toMatchObject({ matterId: "matter-1" });
  });

  it("omits matterAssignment for an unassigned paralegal", () => {
    const { staff } = makeStaff();
    const list = staff.list(attorney);
    const paralegalEntry = list.find((m) => m.username === "paralegal1")!;
    expect(paralegalEntry.matterAssignment).toBeUndefined();
  });

  it("surfaces email/phone once set, and omits them until then", () => {
    const { auth, staff } = makeStaff();
    const before = staff.list(attorney).find((m) => m.username === "attorney1")!;
    expect(before.email).toBeUndefined();
    expect(before.phone).toBeUndefined();

    const ada = auth.listUsers().find((u) => u.actorId === "a1")!;
    auth.setEmail(ada.id, "ada@example.com");
    auth.setPhone(ada.id, "+15551234567");

    const after = staff.list(attorney).find((m) => m.username === "attorney1")!;
    expect(after.email).toBe("ada@example.com");
    expect(after.phone).toBe("+15551234567");
  });
});

describe("StaffService.emailForActorId", () => {
  it("is the opposite gate of list() — system-only", () => {
    const { staff } = makeStaff();
    expect(() => staff.emailForActorId(attorney, "a1")).toThrow(AccessDeniedError);
    expect(() => staff.emailForActorId(system, "a1")).not.toThrow();
  });

  it("resolves a known actorId's email for the system credential", () => {
    const { auth, staff } = makeStaff();
    const ada = auth.listUsers().find((u) => u.actorId === "a1")!;
    auth.setEmail(ada.id, "ada@example.com");
    expect(staff.emailForActorId(system, "a1")).toBe("ada@example.com");
  });

  it("returns undefined for an actorId with no account, or no email on file", () => {
    const { staff } = makeStaff();
    expect(staff.emailForActorId(system, "no-such-actor")).toBeUndefined();
    expect(staff.emailForActorId(system, "a1")).toBeUndefined();
  });
});
