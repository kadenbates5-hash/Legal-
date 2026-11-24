import { describe, expect, it } from "vitest";
import { extractSignalsFromText, parseHoursUntil, RECORDING_CONSENT_REFUSAL_RE } from "../src/receptionist/signal-extraction.js";

describe("parseHoursUntil, as a voice transcript says it", () => {
  // Wednesday 25 November 2026, 10am.
  const wed = new Date(2026, 10, 25, 10, 0, 0);

  it("reads minutes, however they're counted, as within the hour", () => {
    for (const phrase of ["in 30 minutes", "in thirty minutes", "in forty five minutes", "in like twenty mins", "in half an hour"]) {
      expect(parseHoursUntil(phrase), phrase).toBe(1);
    }
  });

  it("reads spoken numbers past twelve, including compounds", () => {
    expect(parseHoursUntil("in twenty four hours")).toBe(24);
    expect(parseHoursUntil("in forty-eight hours")).toBe(48);
    expect(parseHoursUntil("in fifteen days")).toBe(360);
  });

  it("reads a date said as an ordinal, with or without its month", () => {
    expect(parseHoursUntil("the twenty sixth", wed)).toBe(24);
    expect(parseHoursUntil("november twenty-sixth", wed)).toBe(24);
    expect(parseHoursUntil("the twenty sixth of november", wed)).toBe(24);
    expect(parseHoursUntil("the 27th", wed)).toBe(48);
    expect(parseHoursUntil("the 25th", wed)).toBe(12);
  });

  it("puts a day already past this month into next month", () => {
    expect(parseHoursUntil("the fifth", wed)).toBe(10 * 24);
    // In December, "the fifth" is January's.
    expect(parseHoursUntil("the fifth", new Date(2026, 11, 20, 10, 0, 0))).toBe(16 * 24);
  });

  it("doesn't turn a count into a date", () => {
    expect(parseHoursUntil("my second arrest", wed)).toBeUndefined();
  });

  it("ignores fillers and stutters inside a timing phrase", () => {
    expect(parseHoursUntil("in uh like an hour")).toBe(1);
    expect(parseHoursUntil("tomorrow tomorrow morning")).toBe(24);
  });
});

describe("parseHoursUntil", () => {
  it("parses explicit hour counts", () => {
    expect(parseHoursUntil("in 6 hours")).toBe(6);
  });

  it("parses day counts as 24x hours", () => {
    expect(parseHoursUntil("in 3 days")).toBe(72);
  });

  it("treats today/tomorrow as within 24 hours", () => {
    expect(parseHoursUntil("tomorrow")).toBe(24);
    expect(parseHoursUntil("today")).toBeLessThanOrEqual(24);
  });

  it("returns undefined for no recognizable timing phrase", () => {
    expect(parseHoursUntil("next week sometime")).toBeUndefined();
  });
});

describe("extractSignalsFromText", () => {
  it("only extracts a court-appearance signal when the word 'court' is present", () => {
    expect(extractSignalsFromText("I have court tomorrow").courtAppearanceWithinHours).toBe(24);
    expect(extractSignalsFromText("I'll see you tomorrow").courtAppearanceWithinHours).toBeUndefined();
  });

  it("detects in-custody phrasing", () => {
    expect(extractSignalsFromText("I'm currently in jail").inCustody).toBe(true);
  });

  it("detects an opt-out request", () => {
    expect(extractSignalsFromText("I don't want AI involved").clientRequestedOptOut).toBe(true);
  });

  it("detects a protective-order issue only when both the order and a violation-adjacent word are present", () => {
    expect(extractSignalsFromText("I have a protective order").activeProtectiveOrderIssue).toBeUndefined();
    expect(extractSignalsFromText("I have a protective order and they said I violated it").activeProtectiveOrderIssue).toBe(
      true,
    );
  });

  describe("§7 red-teaming fixes", () => {
    it("detects self-harm/suicide risk language as crisisRisk", () => {
      expect(extractSignalsFromText("I want to kill myself").crisisRisk).toBe(true);
      expect(extractSignalsFromText("I don't want to be here anymore").crisisRisk).toBe(true);
      expect(extractSignalsFromText("I've been feeling suicidal").crisisRisk).toBe(true);
    });

    it("detects immediate danger-from-another-person language as crisisRisk", () => {
      expect(extractSignalsFromText("he's going to kill me, I need help right now").crisisRisk).toBe(true);
      expect(extractSignalsFromText("I'm not safe right now").crisisRisk).toBe(true);
    });

    it("does not false-positive crisisRisk on ordinary distress language", () => {
      expect(extractSignalsFromText("I'm worried about my case").crisisRisk).toBeUndefined();
    });

    it("detects a minor stating their age without requiring the word 'only'", () => {
      expect(extractSignalsFromText("I'm 15").vulnerableCaller).toBe(true);
      expect(extractSignalsFromText("I am a minor").vulnerableCaller).toBe(true);
    });

    it("does not misclassify an adult stating their age as a minor", () => {
      expect(extractSignalsFromText("I'm 25").vulnerableCaller).toBeUndefined();
    });

    it("catches hypothetical/indirect phrasing asking for legal advice", () => {
      expect(extractSignalsFromText("hypothetically, would someone go to jail for that").callerAskedForLegalAdvice).toBe(
        true,
      );
      expect(extractSignalsFromText("what if my brother gets arrested for this").callerAskedForLegalAdvice).toBe(true);
    });

    it("detects explicit refusal of recording consent", () => {
      expect(RECORDING_CONSENT_REFUSAL_RE.test("no, I don't consent to that")).toBe(true);
      expect(RECORDING_CONSENT_REFUSAL_RE.test("please don't record me")).toBe(true);
      expect(RECORDING_CONSENT_REFUSAL_RE.test("sure, that's fine")).toBe(false);
    });
  });
});
