import { describe, expect, it } from "vitest";
import { AccountsService } from "../src/review-ui/accounts-service.js";
import { AuthService } from "../src/core/auth.js";
import { AccessDeniedError, type Actor } from "../src/core/types.js";

const attorney: Actor = { id: "a1", role: "attorney" };
const paralegal: Actor = { id: "p1", role: "paralegal" };

function makeAccounts() {
  const auth = new AuthService();
  auth.createUser({ username: "attorney1", password: "correct-horse", role: "attorney", actorId: "a1" });
  return { auth, accounts: new AccountsService(auth) };
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
});
