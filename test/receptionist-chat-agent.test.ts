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

  it("walks caller-type -> consent -> conflict -> intake questions in order", () => {
    const { session } = makeSession();
    const r1 = session.handleMessage("I'm a new client");
    expect(r1.reply).toMatch(/recorded/i);
    expect(r1.done).toBe(false);

    const r2 = session.handleMessage("sure, that's fine");
    expect(r2.reply).toMatch(/conflict of interest/i);
    expect(r2.done).toBe(false);

    const r3 = session.handleMessage("no one else involved");
    expect(r3.reply).toMatch(/charged with/i);
    expect(r3.done).toBe(false);
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

  it("escalates mid-intake if an answer reveals custody", () => {
    const { session } = makeSession();
    clearGates(session); // now at charge_type question
    session.handleMessage("assault, I think"); // charge_type answer -> asks in_custody
    const result = session.handleMessage("yes"); // answers in_custody=yes -> should escalate
    expect(result.reply).toMatch(/connecting you/i);
    expect(result.done).toBe(true);
  });

  it("routes family members to message-taking, never sharing case details", () => {
    const { session } = makeSession();
    session.handleMessage("I'm calling on behalf of my brother");
    session.handleMessage("okay");
    const result = session.handleMessage("no conflicts");
    expect(result.reply).toMatch(/can't share case details/i);
    expect(result.done).toBe(true);
  });

  it("flags a conflict of interest and hands off instead of looping", () => {
    const { session } = makeSession(["jane doe"]);
    session.handleMessage("I'm a new client");
    session.handleMessage("yes");
    const result = session.handleMessage("Jane Doe");
    expect(result.reply).toMatch(/conflict of interest/i);
    expect(result.done).toBe(true);
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
});
