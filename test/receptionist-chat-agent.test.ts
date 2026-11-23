import { describe, expect, it } from "vitest";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import type { Actor } from "../src/core/types.js";
import type { FirmConfig } from "../src/config/firm-config.js";

const actor: Actor = { id: "r1", role: "receptionist" };

function makeSession(conflictedNames: string[] = []) {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  const router = new Router(accessControl, auditLog);
  const utilization = new UtilizationTracker();
  const session = new ReceptionistChatSession({
    matterId: "m1",
    module: criminalLawModule,
    router,
    actor,
    conflictedNames,
    utilization,
  });
  return { session, utilization };
}

function clearGates(session: ReceptionistChatSession) {
  session.handleMessage("I'm a new client"); // caller type -> consent gate
  session.handleMessage("yes that's fine"); // consent -> conflict gate
  return session.handleMessage("no conflicting parties"); // conflict -> cleared, first intake question
}

describe("receptionist chat agent", () => {
  it("greets with the caller-type question", () => {
    const { session } = makeSession();
    expect(session.greet()).toMatch(/new client|existing client/i);
  });

  it("walks caller-type -> consent -> conflict -> intake questions in order, gating questions first", () => {
    const { session } = makeSession();
    const r1 = session.handleMessage("I'm a new client");
    expect(r1.reply).toMatch(/recorded/i);
    expect(r1.done).toBe(false);

    const r2 = session.handleMessage("sure, that's fine");
    expect(r2.reply).toMatch(/conflict of interest/i);
    expect(r2.done).toBe(false);

    // criminal-law module's gating questions (in_custody, court_date,
    // protective_order_active) must all be asked before any non-gating one.
    const r3 = session.handleMessage("no one else involved");
    expect(r3.reply).toMatch(/custody/i);
    expect(r3.done).toBe(false);

    const r4 = session.handleMessage("no");
    expect(r4.reply).toMatch(/court date/i);
    expect(r4.done).toBe(false);

    const r5 = session.handleMessage("no upcoming date");
    expect(r5.reply).toMatch(/protective order/i);
    expect(r5.done).toBe(false);

    const r6 = session.handleMessage("no");
    expect(r6.reply).toMatch(/charged with/i);
    expect(r6.done).toBe(false);
  });

  it("connects immediately when the caller says they're in custody, at any point", () => {
    const { session } = makeSession();
    const result = session.handleMessage("I'm currently in jail and need help");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("never answers a legal-advice question, and hands off instead", () => {
    const { session } = makeSession();
    session.handleMessage("I'm a new client");
    session.handleMessage("sure");
    const result = session.handleMessage("do I have a case? Am I going to jail?");
    expect(result.reply).not.toMatch(/yes|no,? you/i);
    expect(result.reply).toMatch(/can't answer/i);
    expect(result.done).toBe(true);
  });

  it("gives a vulnerable caller the gentle handoff script, not the legal-advice one", () => {
    const { session } = makeSession();
    const result = session.handleMessage("I'm scared, I don't know what to do, I'm only 15 years old");
    expect(result.reply).not.toMatch(/can't answer/i);
    expect(result.reply).toMatch(/connect you with someone/i);
    expect(result.done).toBe(true);
  });

  it("escalates mid-intake as soon as the gating custody question is answered yes", () => {
    const { session } = makeSession();
    clearGates(session); // now at in_custody question (gating questions asked first)
    const result = session.handleMessage("yes");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("escalates on a self-correction like 'no wait, actually yes' to the custody question", () => {
    const { session } = makeSession();
    clearGates(session); // now at in_custody question
    const result = session.handleMessage("No wait, actually yes");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("escalates mid-intake as soon as the gating protective-order question is answered yes", () => {
    const { session } = makeSession();
    clearGates(session); // now at in_custody
    session.handleMessage("no"); // answers in_custody -> now at court_date
    const result = session.handleMessage("no"); // answers court_date -> now at protective_order_active
    expect(result.reply).toMatch(/protective order/i);

    const escalated = session.handleMessage("yes, there's a restraining order");
    expect(escalated.reply).toMatch(/connecting you/i);
    expect(escalated.done).toBe(true);
  });

  it("escalates mid-intake when the court-date answer implies an imminent appearance", () => {
    const { session } = makeSession();
    clearGates(session); // in_custody question
    session.handleMessage("no"); // not in custody -> court_date question
    const result = session.handleMessage("yes, tomorrow"); // no literal "court" in the answer
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("does not escalate on a court date further than 48 hours out", () => {
    const { session } = makeSession();
    clearGates(session);
    session.handleMessage("no");
    const result = session.handleMessage("yes, in 10 days");
    expect(result.reply).not.toMatch(/connecting you/i);
    expect(result.done).toBe(false);
  });

  it("routes family members to message-taking, never sharing case details", () => {
    const { session } = makeSession();
    session.handleMessage("I'm calling on behalf of my brother");
    session.handleMessage("okay");
    const result = session.handleMessage("no conflicts");
    expect(result.reply).toMatch(/can't share case details/i);
    expect(result.done).toBe(true);
  });

  it("routes billing callers to a dedicated billing handoff, never intake questions or the third-party brush-off", () => {
    const { session } = makeSession();
    session.handleMessage("I have a question about my invoice");
    session.handleMessage("okay");
    const result = session.handleMessage("no conflicts");
    expect(result.reply).toMatch(/billing team/i);
    expect(result.reply).not.toMatch(/can't share case details/i);
    expect(result.done).toBe(true);
  });

  it("flags a conflict of interest from a full sentence, not just an exact name match", () => {
    const { session } = makeSession(["jane doe"]);
    session.handleMessage("I'm a new client");
    session.handleMessage("yes");
    const result = session.handleMessage("The other party involved is Jane Doe, I think.");
    expect(result.reply).toMatch(/conflict of interest/i);
    expect(result.done).toBe(true);
  });

  it("does not false-positive a conflict when no listed name is mentioned", () => {
    const { session } = makeSession(["jane doe"]);
    session.handleMessage("I'm a new client");
    session.handleMessage("yes");
    const result = session.handleMessage("It was just me and John Smith.");
    expect(result.reply).not.toMatch(/conflict of interest/i);
    expect(result.done).toBe(false);
  });

  it("routes an opt-out request straight to a human workflow", () => {
    const { session } = makeSession();
    const result = session.handleMessage("I don't want AI involved in my case, human only please");
    expect(result.reply).toMatch(/no AI involved/i);
    expect(result.done).toBe(true);
  });

  // Regression: `extractSignalsFromText` correctly detects an interpreter
  // request in free text, but nothing ever carried that into `IntakeState`
  // — `state.interpreterNeeded` stayed permanently false, so §2's
  // "language/interpreter is the first triage question" could never
  // actually fire from a caller's own words. Fixed in `handleMessage` by
  // folding `turnSignals.interpreterNeeded` into `this.#state` before the
  // gate dispatch runs.
  it("routes to interpreter selection the moment a caller signals they need one, on the very first turn", () => {
    const { session } = makeSession();
    const result = session.handleMessage("Hi, necesito un intérprete, no hablo inglés bien.");
    expect(result.reply).toMatch(/language/i);
    expect(result.done).toBe(false);
  });

  it("routes to interpreter selection even mid-conversation, preempting whatever gate was pending", () => {
    const { session } = makeSession();
    session.handleMessage("I'm a new client"); // now at consent gate
    const result = session.handleMessage("Actually, I need an interpreter, I don't speak English well.");
    expect(result.reply).toMatch(/language/i);
    expect(result.done).toBe(false);
  });

  it("re-asks the caller type after the interpreter language, so an interpreter-first caller isn't left 'unknown'", () => {
    const { session } = makeSession();
    session.handleMessage("I need an interpreter please.");
    const afterLanguage = session.handleMessage("Spanish");
    expect(afterLanguage.reply).toMatch(/new client|existing client/i);
    const afterType = session.handleMessage("I'm a new client");
    expect(afterType.reply).toMatch(/recorded/i);
    expect(afterType.trace.state.callerType).toBe("new_client");
  });

  it("does not count an interpreter request as an answer to the recording-consent question", () => {
    const { session } = makeSession();
    session.handleMessage("I'm a new client"); // consent gate
    const result = session.handleMessage("I need an interpreter, I don't speak English well.");
    expect(result.trace.state.recordingConsentDisclosed).toBe(false);
    session.handleMessage("Spanish");
    const consentAgain = session.handleMessage("ok");
    expect(consentAgain.trace.state.recordingConsentDisclosed).toBe(true);
  });

  // Regression: the free-text extractor's IN_CUSTODY_RE/PROTECTIVE_ORDER_RE
  // match "in custody"/"protective order" as literal substrings with no
  // negation awareness, so a caller's own phrasing of a "no" answer (which
  // naturally restates the question — "No, I'm not currently in custody")
  // was mis-flagged as a positive signal. `deriveEscalationSignals` used
  // to only forward `inCustody`/`activeProtectiveOrderIssue` when `true`,
  // silently dropping an explicit `false`, so that false positive from the
  // *same turn's* raw text was never overridden and escalated every
  // ordinary negative answer. Fixed by always forwarding the explicit
  // boolean so the caller's actual answer to the gating question wins.
  it("does not falsely escalate when the custody answer's own wording restates the question", () => {
    const { session } = makeSession();
    clearGates(session); // now at in_custody question
    const result = session.handleMessage("No, I'm not currently in custody.");
    expect(result.reply).not.toMatch(/connecting you/i);
    expect(result.done).toBe(false);
    expect(result.reply).toMatch(/court date/i);
  });

  it("does not falsely escalate when the protective-order answer's own wording restates the question", () => {
    const { session } = makeSession();
    clearGates(session); // in_custody
    session.handleMessage("no"); // -> court_date
    session.handleMessage("no upcoming date"); // -> protective_order_active
    const result = session.handleMessage("No, there's no protective order against me.");
    expect(result.reply).not.toMatch(/connecting you/i);
    expect(result.done).toBe(false);
  });

  it("still escalates a denial that mentions an arrest — only a plain denial overrides the extractor", () => {
    const { session } = makeSession();
    clearGates(session);
    const result = session.handleMessage("No, but they arrested me this morning and let me out.");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("still escalates a protective-order answer that describes a violation without saying yes", () => {
    const { session } = makeSession();
    clearGates(session);
    session.handleMessage("no");
    session.handleMessage("no upcoming date");
    const result = session.handleMessage("He keeps violating the protective order and the police came last night.");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("still escalates a genuinely affirmative custody answer phrased the same way", () => {
    const { session } = makeSession();
    clearGates(session);
    const result = session.handleMessage("Yes, I'm currently in custody.");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("surfaces a trace on every turn describing what just happened", () => {
    const { session } = makeSession();
    const greetTurn = session.handleMessage("I'm a new client");
    expect(greetTurn.trace.label).toMatch(/recording consent/i);
    expect(greetTurn.trace.state.callerType).toBe("new_client");

    const emergency = session.handleMessage("I'm currently in custody");
    expect(emergency.trace.label).toMatch(/emergency/i);
    expect(emergency.trace.triggers).toContain("in_custody");
  });

  it("records a completed utilization entry once the session finishes", () => {
    const { session, utilization } = makeSession();
    session.handleMessage("I'm in custody right now");
    expect(utilization.all()).toHaveLength(1);
    expect(utilization.all()[0]!.status).toBe("completed");
  });

  it("does nothing further once the conversation has ended", () => {
    const { session } = makeSession();
    session.handleMessage("I don't want AI involved, human only");
    const after = session.handleMessage("hello?");
    expect(after.done).toBe(true);
  });
});

describe("receptionist chat agent — firm config wiring", () => {
  function makeFirmConfig(overrides?: Partial<FirmConfig>): FirmConfig {
    return {
      firmName: "Acme Defense",
      attorneys: [],
      businessHours: { timezone: "America/New_York", open: "09:00", close: "17:00", days: [1, 2, 3, 4, 5] },
      branding: { tone: "warm", greeting: "Welcome to Acme Defense." },
      jurisdictionRecordingConsent: "two-party-consent",
      ...overrides,
    };
  }

  function makeSessionWithConfig(firmConfig?: FirmConfig, now?: () => Date) {
    const auditLog = new AuditLog();
    const accessControl = new AccessControl(auditLog);
    const router = new Router(accessControl, auditLog);
    return new ReceptionistChatSession({ matterId: "m1", module: criminalLawModule, router, actor, firmConfig, now });
  }

  it("uses the default generic greeting when no firm config is supplied", () => {
    const session = makeSessionWithConfig();
    expect(session.greet()).toMatch(/^Thanks for reaching out\./);
  });

  it("uses the firm's branded greeting when a firm config is supplied", () => {
    // Fixed to a moment within business hours so this test doesn't depend on wall-clock time.
    const session = makeSessionWithConfig(makeFirmConfig(), () => new Date("2026-07-22T15:00:00Z"));
    expect(session.greet()).toMatch(/^Welcome to Acme Defense\./);
  });

  it("prepends an after-hours notice outside business hours, without disabling anything", () => {
    // 2026-07-22 (Wed) 10:00 UTC = 06:00 America/New_York — before the 09:00 open.
    const session = makeSessionWithConfig(makeFirmConfig(), () => new Date("2026-07-22T10:00:00Z"));
    expect(session.greet()).toMatch(/office is currently closed/i);

    // Emergency escalation still works exactly the same after-hours.
    const result = session.handleMessage("I'm currently in jail and need help");
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("does not show the after-hours notice during business hours", () => {
    const session = makeSessionWithConfig(makeFirmConfig(), () => new Date("2026-07-22T15:00:00Z"));
    expect(session.greet()).not.toMatch(/office is currently closed/i);
  });

  it("shows two-party-consent wording immediately after caller-type is identified", () => {
    const session = makeSessionWithConfig(makeFirmConfig({ jurisdictionRecordingConsent: "two-party-consent" }));
    const result = session.handleMessage("I'm a new client");
    expect(result.reply).toMatch(/requires all parties to consent/i);
  });

  it("shows one-party-consent wording when the firm's jurisdiction only requires notice", () => {
    const session = makeSessionWithConfig(makeFirmConfig({ jurisdictionRecordingConsent: "one-party-consent" }));
    const result = session.handleMessage("I'm a new client");
    expect(result.reply).toMatch(/one-party consent rule/i);
  });

  it("falls back to the generic consent script when no firm config is supplied", () => {
    const session = makeSessionWithConfig();
    const result = session.handleMessage("I'm a new client");
    expect(result.reply).toMatch(/permitted under our state's consent rules/i);
  });
});
