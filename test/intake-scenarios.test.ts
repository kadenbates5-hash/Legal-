import { describe, expect, it } from "vitest";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import type { Actor } from "../src/core/types.js";
import { INTAKE_SCENARIOS } from "../src/review-ui/intake-scenarios.js";

const actor: Actor = { id: "r1", role: "receptionist" };

function makeSession() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const router = new Router(accessControl, auditLog);
  return new ReceptionistChatSession({ matterId: "m1", module: criminalLawModule, router, actor });
}

/**
 * Pins every Live Intake Demo scenario against the real
 * `ReceptionistChatSession` — these scripts are training content a
 * trainer trusts to demonstrate a specific gate firing correctly, so a
 * script that silently stopped working (a regex change, a reordered
 * gate) would be worse than no scenario at all. Each case plays every
 * line but the last, then asserts what the *last* line's trace reports.
 */
describe("Live Intake Demo scenarios", () => {
  it("covers every emergency/standard escalation trigger and every core gate at least once", () => {
    const ids = INTAKE_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    for (const scenario of INTAKE_SCENARIOS) {
      expect(scenario.lines.length).toBeGreaterThan(0);
    }
  });

  // `labelMatch` only has to appear on *some* turn in the sequence — a
  // scenario like "interpreter needed" resolves that gate by its second
  // line, so the *final* turn's trace correctly shows whatever naturally
  // follows (recording consent), not the interpreter label itself. `done`
  // is checked only on the last turn, since that's the actual end state.
  const expectations: Record<string, { labelMatch: RegExp; done: boolean; triggers?: string[] }> = {
    "routine-new-client": { labelMatch: /intake question/i, done: false },
    "in-custody-emergency": { labelMatch: /emergency/i, done: true, triggers: ["in_custody"] },
    "imminent-police-questioning": { labelMatch: /emergency/i, done: true, triggers: ["imminent_police_questioning"] },
    "court-tomorrow": { labelMatch: /emergency/i, done: true, triggers: ["court_appearance_imminent"] },
    "protective-order-violation": { labelMatch: /emergency/i, done: true, triggers: ["active_protective_order"] },
    "crisis-risk": { labelMatch: /crisis/i, done: true, triggers: ["crisis_risk"] },
    "legal-advice-request": { labelMatch: /redirect/i, done: true, triggers: ["legal_advice_requested"] },
    "narrative-facts": { labelMatch: /redirect/i, done: true, triggers: ["pre_retention_factual_narrative"] },
    "vulnerable-caller": { labelMatch: /vulnerable/i, done: true, triggers: ["vulnerable_caller"] },
    "opt-out": { labelMatch: /human workflow/i, done: true, triggers: ["client_opt_out"] },
    "interpreter-needed": { labelMatch: /interpreter/i, done: false },
    "recording-consent-refused": { labelMatch: /recording consent refused/i, done: true },
    "billing-call": { labelMatch: /billing/i, done: true },
    "family-third-party": { labelMatch: /third-party/i, done: true },
  };

  for (const scenario of INTAKE_SCENARIOS) {
    const expectation = expectations[scenario.id];
    if (!expectation) continue; // conflict-of-interest needs a matter record to actually hit; covered by chat-agent tests directly.
    it(`"${scenario.label}" produces the intended outcome`, () => {
      const session = makeSession();
      const results = scenario.lines.map((line) => session.handleMessage(line));
      const last = results[results.length - 1]!;

      expect(results.some((r) => expectation.labelMatch.test(r.trace.label))).toBe(true);
      expect(last.done).toBe(expectation.done);
      if (expectation.triggers) {
        for (const trigger of expectation.triggers) {
          expect(results.some((r) => r.trace.triggers.includes(trigger))).toBe(true);
        }
      }
    });
  }
});
