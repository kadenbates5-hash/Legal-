import { describe, expect, it } from "vitest";
import { classifyConsentAnswer, classifySideQuestion, sideAnswerFor } from "../src/receptionist/side-questions.js";
import { ReceptionistChatSession } from "../src/receptionist/chat-agent.js";
import { Router } from "../src/core/router.js";
import { AccessControl } from "../src/core/access-control.js";
import { AuditLog } from "../src/core/audit.js";
import { criminalLawModule } from "../src/modules/criminal-law/index.js";
import { extractSignalsFromText, parseHoursUntil } from "../src/receptionist/signal-extraction.js";
import type { FirmConfig } from "../src/config/firm-config.js";
import type { Actor } from "../src/core/types.js";

describe("classifyConsentAnswer", () => {
  it.each(["No.", "nope", "nah", "I'd rather not", "not okay", "no thanks", "please don't record me", "I don't want to be recorded"])(
    "treats %s as a refusal",
    (text) => expect(classifyConsentAnswer(text)).toBe("refuse"),
  );
  it.each(["yes", "Yes, that's fine with me.", "ok", "sure", "No problem", "no worries", "no, that's fine", "I don't mind", "go ahead"])(
    "treats %s as agreement",
    (text) => expect(classifyConsentAnswer(text)).toBe("agree"),
  );
  it.each(["maybe", "I guess", "hmm", "", "Taylor Brooks"])("treats %s as unclear, never as agreement", (text) =>
    expect(classifyConsentAnswer(text)).toBe("unclear"),
  );
});

describe("classifySideQuestion", () => {
  it("recognises a request to repeat, with or without a filler", () => {
    for (const text of ["what?", "um what?", "sorry?", "can you repeat that?", "I didn't catch that"]) {
      expect(classifySideQuestion(text, "intake"), text).toBe("repeat");
    }
  });

  it("recognises questions about who is answering", () => {
    for (const text of ["are you a robot?", "am I talking to a real person?", "who is this?", "is this AI?"]) {
      expect(classifySideQuestion(text, "intake"), text).toBe("identity");
    }
  });

  it("treats a reply that opens with an answer as an answer, even ending in a question mark", () => {
    for (const text of ["yes?", "no, why?", "nope?", "Not that I know of?"]) {
      expect(classifySideQuestion(text, "intake"), text).toBeUndefined();
    }
  });

  it("explains recording at any gate, and the conflict check at its own gate", () => {
    expect(classifySideQuestion("why?", "consent")).toBe("why_recording");
    expect(classifySideQuestion("is this being recorded?", "intake")).toBe("why_recording");
    expect(classifySideQuestion("why do you need that?", "conflict")).toBe("why_conflict");
  });

  it("screens an unrecognised question at the conflict gate as an answer rather than skipping the check", () => {
    expect(classifySideQuestion("does Taylor Brooks count?", "conflict")).toBeUndefined();
  });
});

describe("sideAnswerFor", () => {
  const firm = {
    firmName: "Brooks & Lee",
    attorneys: [],
    businessHours: { timezone: "America/New_York", open: "09:00", close: "17:30", days: [1, 2, 3, 4, 5] },
    branding: { tone: "warm", greeting: "Hi." },
    jurisdictionRecordingConsent: "two-party-consent",
    letterhead: { addressLines: ["1 Main St", "Springfield"], phone: "555-0100" },
  } as FirmConfig;

  it("uses the firm's own hours and address when configured", () => {
    expect(sideAnswerFor("hours", firm)).toBe("Our office hours are Monday to Friday, 9am to 5:30pm.");
    expect(sideAnswerFor("office", firm)).toBe("Our office is at 1 Main St, Springfield, and our number is 555-0100.");
    expect(sideAnswerFor("identity", firm)).toMatch(/automated assistant for Brooks & Lee/);
  });

  it("never gives legal content or a promise beyond a follow-up", () => {
    for (const kind of ["repeat", "identity", "fees", "hours", "office", "callback", "why_recording", "why_conflict", "clarify_caller_type", "other"] as const) {
      const text = sideAnswerFor(kind);
      expect(text, kind).not.toMatch(/\b(guilty|innocent|plead|sentence|you should|will win|will lose|dismiss)/i);
    }
  });
});

describe("timing and custody details", () => {
  const wednesday = new Date(2026, 10, 25, 10, 0, 0);

  it("reads weekdays and dates relative to now, choosing the soonest", () => {
    expect(parseHoursUntil("Friday", wednesday)).toBe(48);
    expect(parseHoursUntil("next Monday", wednesday)).toBe(120);
    expect(parseHoursUntil("on 11/26", wednesday)).toBe(24);
    expect(parseHoursUntil("Nov 30th", wednesday)).toBe(120);
    expect(parseHoursUntil("in two hours", wednesday)).toBe(2);
    expect(parseHoursUntil("in about three weeks", wednesday)).toBe(504);
    expect(parseHoursUntil("Friday, or maybe tomorrow", wednesday)).toBe(24);
  });

  it("treats someone else's arrest as custody, but not the caller's own past arrest", () => {
    expect(extractSignalsFromText("my daughter was arrested this morning").inCustody).toBe(true);
    expect(extractSignalsFromText("I was arrested last year").inCustody).toBeUndefined();
    expect(extractSignalsFromText("I got booked into county").inCustody).toBe(true);
    expect(extractSignalsFromText("I'm being held at the station").inCustody).toBe(true);
  });

  it("ignores a negated custody phrase but not a nearby bare 'no'", () => {
    expect(extractSignalsFromText("No, I'm not in jail").inCustody).toBeUndefined();
    expect(extractSignalsFromText("I've never been arrested").inCustody).toBeUndefined();
    expect(extractSignalsFromText("No, my husband is in jail").inCustody).toBe(true);
  });
});

const actor: Actor = { id: "r1", role: "receptionist" };
function makeSession(firmConfig?: FirmConfig) {
  const auditLog = new AuditLog();
  return new ReceptionistChatSession({
    matterId: "m1",
    module: criminalLawModule,
    router: new Router(new AccessControl(auditLog), auditLog),
    actor,
    ...(firmConfig ? { firmConfig } : {}),
  });
}
function clearGates(session: ReceptionistChatSession) {
  session.handleMessage("I'm a new client");
  session.handleMessage("yes");
  return session.handleMessage("Taylor Brooks");
}

describe("the gates under real answers", () => {
  it("never skips the custody question when the caller asks something back", () => {
    const session = makeSession();
    expect(clearGates(session).reply).toMatch(/currently in custody/);
    const side = session.handleMessage("are you a robot?");
    expect(side.done).toBe(false);
    expect(side.reply).toMatch(/automated assistant/);
    expect(side.reply).toMatch(/Are you currently in custody\?$/);
    const answered = session.handleMessage("yes, I'm in jail");
    expect(answered.done).toBe(true);
    expect(answered.trace.triggers).toContain("in_custody");
  });

  it("hands off after several questions back in a row, so a call can't circle", () => {
    const session = makeSession();
    clearGates(session);
    session.handleMessage("who is this?");
    session.handleMessage("how much do you charge?");
    const third = session.handleMessage("what are your hours?");
    expect(third.done).toBe(true);
    expect(third.trace.label).toMatch(/several questions/i);
  });

  it("treats a plain 'No.' to recording as a refusal, not consent", () => {
    const session = makeSession();
    session.handleMessage("I'm a new client");
    const result = session.handleMessage("No.");
    expect(result.done).toBe(true);
    expect(result.trace.label).toMatch(/consent refused/i);
  });

  it("asks once more for an unclear consent answer, then hands off without recording", () => {
    const session = makeSession();
    session.handleMessage("I'm a new client");
    const first = session.handleMessage("I guess");
    expect(first.done).toBe(false);
    expect(first.reply).toMatch(/yes or a no/);
    const second = session.handleMessage("hmm");
    expect(second.done).toBe(true);
    expect(second.reply).toMatch(/isn't recorded/);
    expect(second.trace.state.recordingConsentDisclosed).toBe(false);
  });

  it("lets an emergency in the same message win over a refusal", () => {
    const session = makeSession();
    session.handleMessage("I'm a new client");
    const result = session.handleMessage("no, and my son is in jail right now");
    expect(result.trace.triggers).toContain("in_custody");
  });

  it("keeps notice-only behaviour for a one-party-consent firm", () => {
    const firm = {
      firmName: "F",
      attorneys: [],
      businessHours: { timezone: "UTC", open: "00:00", close: "23:59", days: [0, 1, 2, 3, 4, 5, 6] },
      branding: { tone: "neutral", greeting: "Hi." },
      jurisdictionRecordingConsent: "one-party-consent",
    } as FirmConfig;
    const session = makeSession(firm);
    session.handleMessage("I'm a new client");
    const result = session.handleMessage("I guess");
    expect(result.trace.label).toMatch(/conflict/i);
  });

  it("recognises a new client who never says the words 'new client'", () => {
    const session = makeSession();
    const result = session.handleMessage("Hi, I got a DUI last night and need a lawyer");
    expect(result.trace.state.callerType).toBe("new_client");
    expect(result.trace.label).toMatch(/consent/i);
  });

  it("asks once who the call is about, then takes a message without the third-party line", () => {
    const session = makeSession();
    const clarify = session.handleMessage("hello");
    expect(clarify.reply).toMatch(/your own legal matter, or are you calling for someone else/);
    const answered = session.handleMessage("my own");
    expect(answered.trace.state.callerType).toBe("new_client");

    const unknown = makeSession();
    unknown.handleMessage("hello");
    unknown.handleMessage("hmm");
    unknown.handleMessage("yes");
    const end = unknown.handleMessage("nobody");
    expect(end.done).toBe(true);
    expect(end.reply).not.toMatch(/can't share case details/);
    expect(end.reply).toMatch(/pass along/);
  });

  it("still treats 'someone else' as a third party, never as the client", () => {
    const session = makeSession();
    session.handleMessage("hello");
    expect(session.handleMessage("someone else").trace.state.callerType).toBe("family_or_third_party");
  });
});
