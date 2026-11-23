import { describe, expect, it } from "vitest";
import { MatterStore, type MatterParty, type MatterStatus, type PartyRole } from "../src/core/matters.js";
import { ConflictChecker, compareNames, normalizeName, type ConflictAuditReport } from "../src/core/conflicts.js";
import { MattersService } from "../src/review-ui/matters-service.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { AccessDeniedError } from "../src/core/types.js";

function party(name: string, role: PartyRole, note?: string): MatterParty {
  return { name, role, note, email: undefined, phone: undefined };
}

function book(matters: Array<{ id: string; status?: MatterStatus; parties: MatterParty[] }>): MatterStore {
  const store = new MatterStore();
  for (const m of matters) store.upsert(m.id, { title: `Matter ${m.id}`, status: m.status ?? "open", parties: m.parties });
  return store;
}

function audit(store: MatterStore, options?: { maxFindings?: number }): ConflictAuditReport {
  return new ConflictChecker(store).audit(options);
}

describe("firm-wide conflicts audit", () => {
  it("finds a current client who is adverse on another open matter (Rule 1.7)", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("Dana Vance", "client"), party("The State", "adverse")] },
        { id: "m2", parties: [party("Ray Okafor", "client"), party("Dana Vance", "adverse")] },
      ]),
    );
    expect(report.findings).toHaveLength(1);
    const [f] = report.findings;
    expect(f!.kind).toBe("opposite_sides");
    expect(f!.severity).toBe("current_adversity");
    expect(f!.matchStrength).toBe("exact");
    expect(f!.sameMatter).toBe(false);
    expect(f!.appearances.map((a) => `${a.role}:${a.matterId}`)).toEqual(["adverse:m2", "client:m1"]);
    expect(f!.explanation).toContain("Rule 1.7");
    expect(report.countsBySeverity.current_adversity).toBe(1);
  });

  it("grades a former client now adverse as Rule 1.9, and old adversity below that", () => {
    const report = audit(
      book([
        { id: "closed-client", status: "closed", parties: [party("Lena Park", "client")] },
        { id: "open-adverse", parties: [party("Lena Park", "adverse")] },
        { id: "closed-adverse", status: "closed", parties: [party("Omar Haddad", "adverse")] },
        { id: "open-client", parties: [party("Omar Haddad", "client")] },
      ]),
    );
    const bySeverity = Object.fromEntries(report.findings.map((f) => [f.appearances[0]!.name, f.severity]));
    expect(bySeverity["Lena Park"]).toBe("former_client_adversity");
    expect(bySeverity["Omar Haddad"]).toBe("past_adversity");
    // Worst first.
    expect(report.findings.map((f) => f.severity)).toEqual(["former_client_adversity", "past_adversity"]);
  });

  it("treats a prospective matter as live, the same as a conflicts check does", () => {
    const report = audit(
      book([
        { id: "p", status: "prospective", parties: [party("Ivo Brandt", "adverse")] },
        { id: "o", parties: [party("Ivo Brandt", "client")] },
      ]),
    );
    expect(report.findings[0]!.severity).toBe("current_adversity");
  });

  it("calls out one matter listing the same person on both sides as a data-entry problem", () => {
    const report = audit(book([{ id: "m1", parties: [party("Kai Moreno", "client"), party("Kai Moreno", "adverse")] }]));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.sameMatter).toBe(true);
    expect(report.findings[0]!.explanation).toContain("data-entry");
    expect(report.findings[0]!.explanation).toContain("'m1'");
  });

  it("matches across name shapes and says when a match isn't exact", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("SMITH, Johnathan Q.", "client")] },
        { id: "m2", parties: [party("Johnathan Smith", "adverse")] },
        { id: "m3", parties: [party("Acme, Inc.", "client")] },
        { id: "m4", parties: [party("ACME Corporation", "adverse")] },
        { id: "m5", parties: [party("Priya Natarajan", "client")] },
        { id: "m6", parties: [party("P. Natarajan", "adverse")] },
      ]),
    );
    const strengths = Object.fromEntries(report.findings.map((f) => [f.appearances.map((a) => a.matterId).sort().join("+"), f.matchStrength]));
    expect(strengths["m1+m2"]).toBe("strong");
    expect(strengths["m3+m4"]).toBe("exact");
    expect(strengths["m5+m6"]).toBe("possible");
    const possible = report.findings.find((f) => f.matchStrength === "possible")!;
    expect(possible.explanation).toContain("confirm it's the same person");
  });

  it("doesn't list a returning client, or an adversary the firm faces on every matter", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("Dana Vance", "client"), party("The State", "adverse")] },
        { id: "m2", parties: [party("Dana Vance", "client"), party("The State", "adverse")] },
        { id: "m3", parties: [party("Ray Okafor", "client"), party("The State", "adverse")] },
      ]),
    );
    expect(report.findings).toEqual([]);
    expect(report.notCovered.join(" ")).toContain("returning client");
  });

  it("lists one client written two ways for review, not as adversity", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("Maria Ruiz", "client")] },
        { id: "m2", parties: [party("Maria Elena Ruiz", "client")] },
      ]),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.kind).toBe("spelling_variant");
    expect(report.findings[0]!.severity).toBe("review");
    expect(report.findings[0]!.appearances.map((a) => a.name)).toEqual(["Maria Ruiz", "Maria Elena Ruiz"]);
  });

  it("doesn't call two clients sharing a surname and initial a spelling variant", () => {
    // "possible" is the right reading for adversity, but as a spelling
    // list it would flag every pair of relatives.
    const report = audit(
      book([
        { id: "m1", parties: [party("Jane Smith", "client")] },
        { id: "m2", parties: [party("John Smith", "client")] },
      ]),
    );
    expect(report.findings).toEqual([]);
  });

  it("still reports adversity on a possible match", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("Jane Smith", "client")] },
        { id: "m2", parties: [party("John Smith", "adverse")] },
      ]),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.matchStrength).toBe("possible");
    expect(report.findings[0]!.severity).toBe("current_adversity");
  });

  it("ignores related parties and says so", () => {
    const report = audit(
      book([
        { id: "m1", parties: [party("Dana Vance", "client")] },
        { id: "m2", parties: [party("Dana Vance", "related", "witness")] },
      ]),
    );
    expect(report.findings).toEqual([]);
    expect(report.partiesCompared).toBe(1);
    expect(report.notCovered.join(" ")).toContain("related");
  });

  it("keeps one finding per name with every matter on each side, however many matters", () => {
    const matters = [{ id: "client", parties: [party("The State", "client")] }];
    for (let i = 0; i < 40; i++) matters.push({ id: `m${i}`, parties: [party("The State", "adverse")] });
    const report = audit(book(matters));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.appearances).toHaveLength(41);
  });

  it("cuts a long list short visibly, worst findings kept", () => {
    const matters = [];
    for (let i = 0; i < 12; i++) {
      matters.push({ id: `c${i}`, parties: [party(`Person Number${i}`, "client")] });
      matters.push({ id: `a${i}`, status: (i < 4 ? "open" : "closed") as MatterStatus, parties: [party(`Person Number${i}`, "adverse")] });
    }
    const report = audit(book(matters), { maxFindings: 5 });
    expect(report.totalFindings).toBe(12);
    expect(report.findings).toHaveLength(5);
    expect(report.truncated).toBe(true);
    expect(report.findings.slice(0, 4).every((f) => f.severity === "current_adversity")).toBe(true);
    // The counts cover everything, not just what was kept.
    expect(report.countsBySeverity.current_adversity + report.countsBySeverity.past_adversity).toBe(12);
  });

  it("never misses an opposite-side pair that comparing every name with every other would find", () => {
    // The audit only compares names that share a token. Check that
    // shortcut against brute force on a seeded random book.
    let seed = 20261123;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const firsts = ["John", "Jon", "J.", "Jane", "Ana", "Anna", "Li", "Mo", "Ola"];
    const middles = ["", "Q.", "Marie", "de la"];
    const lasts = ["Smith", "Smyth", "Ruiz", "Ng", "Okafor", "Acme Corp", "State"];
    const roles: PartyRole[] = ["client", "adverse", "related"];
    const statuses: MatterStatus[] = ["open", "closed", "prospective"];

    let pairsChecked = 0;
    for (let round = 0; round < 15; round++) {
      const matters = Array.from({ length: 25 }, (_, i) => ({
        id: `r${round}-${i}`,
        status: pick(statuses),
        parties: Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
          party([pick(firsts), pick(middles), pick(lasts)].filter(Boolean).join(" "), pick(roles)),
        ),
      }));
      const report = audit(book(matters), { maxFindings: 100000 });

      const all = matters.flatMap((m) => m.parties.filter((p) => p.role !== "related").map((p) => p));
      const expected = new Set<string>();
      for (const a of all) {
        for (const b of all) {
          if (a.role !== "client" || b.role !== "adverse") continue;
          if (!compareNames(a.name, b.name)) continue;
          const [x, y] = [normalizeName(a.name).normalized, normalizeName(b.name).normalized].sort();
          expected.add(`${x}|${y}`);
        }
      }
      const found = new Set<string>();
      for (const f of report.findings.filter((f) => f.kind === "opposite_sides")) {
        const names = [...new Set(f.appearances.map((a) => normalizeName(a.name).normalized))].sort();
        found.add(names.length === 1 ? `${names[0]}|${names[0]}` : names.join("|"));
      }
      expect(found).toEqual(expected);
      pairsChecked += expected.size;
    }
    // Not vacuous: the random books really do contain plenty of pairs.
    expect(pairsChecked).toBeGreaterThan(100);
  });

  it("stays fast on a large book", () => {
    const matters = [];
    for (let i = 0; i < 3000; i++) {
      matters.push({
        id: `m${i}`,
        parties: [party(`Client${i} Surname${i % 400}`, "client"), party("The State", "adverse"), party(`Witness${i}`, "related")],
      });
    }
    const started = Date.now();
    const report = audit(book(matters));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(report.mattersScanned).toBe(3000);
    // Clients sharing a surname and initial are relatives, not a 9,800-row spelling list.
    expect(report.totalFindings).toBe(0);
  });

  it("changes nothing in the book it reads", () => {
    const store = book([
      { id: "m1", parties: [party("Dana Vance", "client")] },
      { id: "m2", parties: [party("Dana Vance", "adverse")] },
    ]);
    const before = JSON.stringify(store.toSnapshot());
    audit(store);
    expect(JSON.stringify(store.toSnapshot())).toBe(before);
  });
});

describe("MattersService.auditConflicts", () => {
  function service() {
    const store = book([
      { id: "m1", parties: [party("Dana Vance", "client")] },
      { id: "m2", status: "closed", parties: [party("Dana Vance", "adverse")] },
    ]);
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    accessControl.assignParalegal("p1", "m1");
    return { auditLog, matters: new MattersService({ store, checker: new ConflictChecker(store), accessControl, auditLog }) };
  }

  it("is attorney-only, even for a paralegal who can run a check", () => {
    const { matters } = service();
    expect(() => matters.auditConflicts({ id: "p1", role: "paralegal" })).toThrow(AccessDeniedError);
    expect(() => matters.auditConflicts({ id: "r1", role: "receptionist" })).toThrow(AccessDeniedError);
    expect(() => matters.auditConflicts({ id: "c1", role: "client" })).toThrow(AccessDeniedError);
  });

  it("records every run with what it found", () => {
    const { matters, auditLog } = service();
    const report = matters.auditConflicts({ id: "a1", role: "attorney" });
    expect(report.findings).toHaveLength(1);
    const entry = auditLog.read("attorney").find((e) => e.action === "conflicts_audit_run");
    expect(entry).toBeDefined();
    expect(entry!.actor.id).toBe("a1");
    expect(entry!.detail).toContain("findings=1");
    expect(entry!.detail).toContain("past=1");
  });

  it("records nothing when refused", () => {
    const { matters, auditLog } = service();
    try {
      matters.auditConflicts({ id: "p1", role: "paralegal" });
    } catch {
      /* expected */
    }
    expect(auditLog.read("attorney").some((e) => e.action === "conflicts_audit_run")).toBe(false);
  });
});
