import { describe, expect, it } from "vitest";
import { MatterStore } from "../src/core/matters.js";
import { ConflictChecker, compareNames, normalizeName } from "../src/core/conflicts.js";

describe("normalizeName", () => {
  it("reorders 'Last, First' into first-last order", () => {
    expect(normalizeName("Smith, John").normalized).toBe("john smith");
  });

  it("strips honorifics, generational and professional suffixes", () => {
    expect(normalizeName("Dr. John Smith Jr., Esq.").normalized).toBe("john smith");
  });

  it("strips diacritics so alternate spellings still screen alike", () => {
    expect(normalizeName("José Muñoz").normalized).toBe(normalizeName("Jose Munoz").normalized);
  });

  it("drops entity-type suffixes so Acme Inc and Acme Corporation are one adversary", () => {
    expect(normalizeName("Acme, Inc.").normalized).toBe("acme");
    expect(normalizeName("ACME Corporation").normalized).toBe("acme");
  });

  it("does not mangle an entity name that merely contains a comma", () => {
    // The comma-swap must not turn "Acme, Inc." into "inc acme".
    expect(normalizeName("Acme, Inc.").normalized).toBe("acme");
  });
});

describe("compareNames", () => {
  it("matches identical names exactly, regardless of case and punctuation", () => {
    expect(compareNames("John Smith", "john  smith!")).toBe("exact");
  });

  it("matches across the Last-First form", () => {
    expect(compareNames("Smith, John", "John Smith")).toBe("exact");
  });

  it("treats an added middle name as a strong match", () => {
    expect(compareNames("John Smith", "John Quincy Smith")).toBe("strong");
  });

  it("matches an organization referred to by its distinctive word", () => {
    expect(compareNames("Acme", "Acme Holdings")).toBe("strong");
  });

  it("flags same-surname-same-initial as a weak, human-triageable match", () => {
    expect(compareNames("J. Smith", "John Smith")).toBe("possible");
  });

  it("does not match unrelated names", () => {
    expect(compareNames("John Smith", "Maria Garcia")).toBeUndefined();
  });

  it("does not match on a surname alone when first initials differ", () => {
    expect(compareNames("Alice Smith", "Bob Smith")).toBeUndefined();
  });

  it("ignores a too-short single token rather than matching half the world", () => {
    expect(compareNames("Jo", "Jo Anne Smith")).toBeUndefined();
  });

  it("returns undefined for empty or punctuation-only input", () => {
    expect(compareNames("", "John Smith")).toBeUndefined();
    expect(compareNames("...", "John Smith")).toBeUndefined();
  });
});

function firmWithMatters() {
  const matters = new MatterStore();
  matters.upsert("m-100", {
    title: "State v. Ruiz",
    status: "open",
    parties: [
      { name: "Carlos Ruiz", role: "client", note: undefined },
      { name: "Acme Corp", role: "adverse", note: "complainant" },
    ],
  });
  matters.upsert("m-200", {
    title: "Vance dissolution",
    status: "closed",
    parties: [
      { name: "Dana Vance", role: "client", note: undefined },
      { name: "Peter Vance", role: "adverse", note: undefined },
    ],
  });
  return { matters, checker: new ConflictChecker(matters) };
}

describe("ConflictChecker", () => {
  it("flags a prospective client who is adverse to a current client as a direct conflict", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["Carlos Ruiz"], roleByName: { "Carlos Ruiz": "adverse" } });
    expect(result.requiresAttorneyReview).toBe(true);
    expect(result.hits[0]!.severity).toBe("direct");
    expect(result.hits[0]!.explanation).toMatch(/1\.7/);
  });

  it("flags representing someone against a former client under Rule 1.9, not 1.7", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["Dana Vance"], roleByName: { "Dana Vance": "adverse" } });
    expect(result.hits[0]!.severity).toBe("former_client");
    expect(result.hits[0]!.explanation).toMatch(/1\.9/);
    expect(result.requiresAttorneyReview).toBe(true);
  });

  it("surfaces an existing client on the same side without demanding review", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["Carlos Ruiz"], roleByName: { "Carlos Ruiz": "client" } });
    expect(result.hits[0]!.severity).toBe("same_side");
    expect(result.requiresAttorneyReview).toBe(false);
  });

  it("catches an adversary written a different way (entity suffix dropped)", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["ACME, Incorporated"], roleByName: { "ACME, Incorporated": "client" } });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.severity).toBe("direct");
  });

  it("searches the whole firm, not just one lawyer's matters (Rule 1.10 imputation)", () => {
    const { checker } = firmWithMatters();
    // Nothing about the request scopes to a user; both matters are reachable.
    const result = checker.check({ names: ["Carlos Ruiz", "Peter Vance"] });
    expect(new Set(result.hits.map((h) => h.matterId))).toEqual(new Set(["m-100", "m-200"]));
  });

  it("can exclude a matter, so re-screening one against the rest doesn't match itself", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["Carlos Ruiz"], excludeMatterId: "m-100" });
    expect(result.hits).toHaveLength(0);
  });

  it("orders the most serious hits first so a triaging attorney reads them in priority order", () => {
    const matters = new MatterStore();
    matters.upsert("m-a", { status: "open", parties: [{ name: "Jane Doe", role: "related", note: undefined }] });
    matters.upsert("m-b", { status: "open", parties: [{ name: "Jane Doe", role: "client", note: undefined }] });
    const result = new ConflictChecker(matters).check({ names: ["Jane Doe"], roleByName: { "Jane Doe": "adverse" } });
    expect(result.hits[0]!.severity).toBe("direct");
  });

  it("reports no hits — and no required review — for a genuinely new party", () => {
    const { checker } = firmWithMatters();
    const result = checker.check({ names: ["Wholly Unrelated Person"] });
    expect(result.hits).toHaveLength(0);
    expect(result.requiresAttorneyReview).toBe(false);
  });

  it("finds nothing when the firm has recorded no parties — and says so rather than implying safety", () => {
    const result = new ConflictChecker(new MatterStore()).check({ names: ["Anyone"] });
    expect(result.hits).toHaveLength(0);
    expect(result.checkedAt).toBeTruthy();
  });
});

describe("MatterStore", () => {
  it("upserts, preserving openedAt while updating updatedAt", () => {
    const store = new MatterStore();
    const first = store.upsert("m-1", { title: "Original" });
    const second = store.upsert("m-1", { title: "Renamed" });
    expect(second.openedAt).toBe(first.openedAt);
    expect(second.title).toBe("Renamed");
  });

  it("defaults the title to the matter id so a bare id is still usable", () => {
    expect(new MatterStore().upsert("m-9", {}).title).toBe("m-9");
  });

  it("stamps closedAt on close and clears it on reopen, so status and date can't disagree", () => {
    const store = new MatterStore();
    store.upsert("m-1", {});
    expect(store.upsert("m-1", { status: "closed" }).closedAt).toBeTruthy();
    expect(store.upsert("m-1", { status: "open" }).closedAt).toBeUndefined();
  });

  it("rejects an empty matter id", () => {
    expect(() => new MatterStore().upsert("   ", {})).toThrow();
  });

  it("round-trips through toSnapshot/fromSnapshot including parties", () => {
    const store = new MatterStore();
    store.upsert("m-1", { title: "T", parties: [{ name: "A", role: "client", note: "n" }] });
    const restored = MatterStore.fromSnapshot(store.toSnapshot());
    expect(restored.get("m-1")!.parties[0]!.name).toBe("A");
  });
});

describe("receptionist intake, screened against real firm records", () => {
  it("stops an intake when the caller names a party adverse to a current client", async () => {
    const { ReceptionistChatSession } = await import("../src/receptionist/chat-agent.js");
    const { Router } = await import("../src/core/router.js");
    const { AccessControl } = await import("../src/core/access-control.js");
    const { AuditLog } = await import("../src/core/audit.js");
    const { criminalLawModule } = await import("../src/modules/criminal-law/index.js");

    const matters = new MatterStore();
    matters.upsert("m-100", {
      status: "open",
      parties: [{ name: "Carlos Ruiz", role: "client", note: undefined }],
    });

    const auditLog = new AuditLog();
    const session = new ReceptionistChatSession({
      matterId: "intake-1",
      module: criminalLawModule,
      router: new Router(new AccessControl(auditLog), auditLog, criminalLawModule),
      actor: { id: "r1", role: "receptionist" },
      conflictChecker: new ConflictChecker(matters),
    });

    session.greet();
    let reply = "";
    // Walk the scripted gates until the conflict-check gate is reached, then
    // name an existing client as the person on the other side.
    for (const answer of ["I'm a new client", "yes", "The other side is Carlos Ruiz"]) {
      reply = session.handleMessage(answer).reply;
    }
    expect(reply).toMatch(/conflict of interest/i);
  });
});
