import { describe, expect, it } from "vitest";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { UtilizationTracker } from "../src/core/utilization.js";
import type { Actor } from "../src/core/types.js";

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

    // criminal-law module's questions are [charge_type (non-gating), in_custody
    // (gating), court_date (gating)] — the agent must ask the gating ones first.
    const r3 = session.handleMessage("no one else involved");
    expect(r3.reply).toMatch(/custody/i);
    expect(r3.done).toBe(false);

    const r4 = session.handleMessage("no");
    expect(r4.reply).toMatch(/court date/i);
    expect(r4.done).toBe(false);

    const r5 = session.handleMessage("no upcoming date");
    expect(r5.reply).toMatch(/charged with/i);
    expect(r5.done).toBe(false);
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
