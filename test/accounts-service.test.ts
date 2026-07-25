import { describe, expect, it } from "vitest";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { AuthService } from "../src/core/auth.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeAccounts() {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  const accessControl = new AccessControl(new AuditLog());
  return { auth, accessControl, accounts: new AccountsService(auth, accessControl) };
}

describe("AccountsService (attorney-only surface)", () => {
  it("denies every method to a non-attorney actor, including plain reads", () => {
    const { accounts } = makeAccounts();
    expect(() => accounts.list(paralegal)).toThrow(AccessDeniedError);
    expect(() =>
      accounts.create(paralegal, { username: "new", password: "correct-horse", role: "receptionist" }),
    ).toThrow(AccessDeniedError);
  });

  it("lists accounts without leaking password hashes", () => {
    const { accounts } = makeAccounts();
    const list = accounts.list(attorney);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("passwordHash");
    expect(list[0]).not.toHaveProperty("salt");
    expect(list[0]).toMatchObject({ username: "attorney1", role: "attorney", disabled: false });
  });

  it("creates a new account", () => {
    const { accounts } = makeAccounts();
    const created = accounts.create(attorney, { username: "reception1", password: "correct-horse", role: "receptionist" });
    expect(created.role).toBe("receptionist");
    expect(accounts.list(attorney)).toHaveLength(2);
  });

  it("disables and re-enables an account", () => {
    const { accounts } = makeAccounts();
    const created = accounts.create(attorney, { username: "reception1", password: "correct-horse", role: "receptionist" });
    const disabled = accounts.disable(attorney, created.id);
    expect(disabled.disabled).toBe(true);
    const enabled = accounts.enable(attorney, created.id);
    expect(enabled.disabled).toBe(false);
  });

  it("propagates the last-enabled-attorney safeguard from AuthService", () => {
    const { accounts } = makeAccounts();
    const onlyAttorney = accounts.list(attorney)[0]!;
    expect(() => accounts.disable(attorney, onlyAttorney.id)).toThrow(/at least one enabled attorney/);
  });

  describe("password reset", () => {
    it("resets a user's password and marks mustChangePassword", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "reception1", password: "correct-horse", role: "receptionist" });
      const updated = accounts.resetPassword(attorney, created.id, "new-temp-password");
      expect(updated.mustChangePassword).toBe(true);

      const relisted = accounts.list(attorney).find((a) => a.id === created.id);
      expect(relisted?.mustChangePassword).toBe(true);
    });

    it("denies password reset to a non-attorney actor", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "reception1", password: "correct-horse", role: "receptionist" });
      expect(() => accounts.resetPassword(paralegal, created.id, "new-temp-password")).toThrow(AccessDeniedError);
    });
  });

  describe("matter assignment", () => {
    it("a fresh paralegal account has no matter assignment", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      expect(created.matterAssignment).toBeUndefined();
    });

    it("assigns a paralegal to a matter, reflected in list() and the assign response", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      const assigned = accounts.assignMatter(attorney, created.id, "m1", true);
      expect(assigned.matterAssignment).toEqual({ actorId: "paralegal1", matterId: "m1", highSensitivityGranted: true });

      const relisted = accounts.list(attorney).find((a) => a.id === created.id);
      expect(relisted?.matterAssignment).toEqual({ actorId: "paralegal1", matterId: "m1", highSensitivityGranted: true });
    });

    it("re-assigning moves the paralegal to a new matter (one matter at a time)", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      accounts.assignMatter(attorney, created.id, "m1");
      const reassigned = accounts.assignMatter(attorney, created.id, "m2");
      expect(reassigned.matterAssignment?.matterId).toBe("m2");
    });

    it("unassigns a matter", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      accounts.assignMatter(attorney, created.id, "m1");
      const unassigned = accounts.unassignMatter(attorney, created.id);
      expect(unassigned.matterAssignment).toBeUndefined();
    });

    it("refuses to assign a matter to a non-paralegal account", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "reception1", password: "correct-horse", role: "receptionist" });
      expect(() => accounts.assignMatter(attorney, created.id, "m1")).toThrow(/matter assignment only applies to paralegal/);
    });

    it("denies matter assignment to a non-attorney actor", () => {
      const { accounts } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      expect(() => accounts.assignMatter(paralegal, created.id, "m1")).toThrow(AccessDeniedError);
    });

    it("assignment made through AccountsService is enforced by the same AccessControl the Drafting panel checks", () => {
      const { accounts, accessControl } = makeAccounts();
      const created = accounts.create(attorney, { username: "paralegal1", password: "correct-horse", role: "paralegal" });
      accounts.assignMatter(attorney, created.id, "m1");
      expect(() =>
        accessControl.authorize({ actor: { id: "paralegal1", role: "paralegal" }, matterId: "m1", category: "case_file" }),
      ).not.toThrow();
      expect(() =>
        accessControl.authorize({ actor: { id: "paralegal1", role: "paralegal" }, matterId: "m2", category: "case_file" }),
      ).toThrow(AccessDeniedError);
    });
  });
});
