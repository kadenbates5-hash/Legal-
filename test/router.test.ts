import { describe, expect, it } from "vitest";
import { Router, newIntakeState } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import type { Actor } from "../src/core/types.js";

const receptionist: Actor = { id: "r1", role: "receptionist" };

function makeRouter() {
  const auditLog = new AuditLog();
  const accessControl = new AccessControl(auditLog);
  return { router: new Router(accessControl, auditLog), auditLog };
}

describe("router intake sequencing", () => {
  it("emergency triggers preempt every sequencing gate", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client", interpreterNeeded: true });
    const decision = router.route(receptionist, state, { inCustody: true });
    expect(decision.directive).toBe("connect_human_immediately");
    expect(decision.clearedForSubstantiveIntake).toBe(false);
  });

  it("routes interpreter need before any other triage question", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client", interpreterNeeded: true });
    const decision = router.route(receptionist, state);
    expect(decision.directive).toBe("route_interpreter_then_continue");
  });

  it("requires recording consent disclosure before conflict check or intake", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client" });
    const decision = router.route(receptionist, state);
    expect(decision.directive).toBe("disclose_recording_consent_then_continue");
  });

  it("holds for conflict check before substantive intake, after consent is disclosed", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client" });
    state.recordingConsentDisclosed = true;
    const decision = router.route(receptionist, state);
    expect(decision.directive).toBe("hold_for_conflict_check");
  });

  it("clears for substantive intake only once every gate has passed", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client" });
    state.recordingConsentDisclosed = true;
    state.conflictCheckRun = true;
    state.conflictCheckResolved = true;
    const decision = router.route(receptionist, state);
    expect(decision.directive).toBe("continue_standard_triage");
    expect(decision.clearedForSubstantiveIntake).toBe(true);
  });

  it("redirects instead of answering a legal-advice question mid-intake", () => {
    const { router } = makeRouter();
    const state = newIntakeState({ matterId: "m1", callerType: "new_client" });
    state.recordingConsentDisclosed = true;
    state.conflictCheckRun = true;
    state.conflictCheckResolved = true;
    const decision = router.route(receptionist, state, { callerAskedForLegalAdvice: true });
    expect(decision.directive).toBe("redirect_no_answer_then_handoff");
    expect(decision.clearedForSubstantiveIntake).toBe(false);
  });

  it("identifies caller type from raw signals", () => {
    const { router } = makeRouter();
    expect(router.identifyCallerType({ statesAsFamilyMember: true })).toBe("family_or_third_party");
    expect(router.identifyCallerType({ statesAsExistingClient: true })).toBe("existing_client");
    expect(router.identifyCallerType({})).toBe("unknown");
  });

  it("classifies an ambiguous caller as family/third-party over existing-client, erring toward confidentiality", () => {
    const { router } = makeRouter();
    expect(router.identifyCallerType({ statesAsFamilyMember: true, statesAsExistingClient: true })).toBe(
      "family_or_third_party",
    );
  });
});
