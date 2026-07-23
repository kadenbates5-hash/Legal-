import { describe, expect, it } from "vitest";
import { extractSignalsFromText, parseHoursUntil } from "../src/receptionist/signal-extraction.js";

describe("parseHoursUntil", () => {
  it("parses explicit hour counts", () => {
    expect(parseHoursUntil("in 6 hours")).toBe(6);
  });

  it("parses day counts as 24x hours", () => {
    expect(parseHoursUntil("in 3 days")).toBe(72);
  });

  it("treats today/tomorrow as within 24 hours", () => {
    expect(parseHoursUntil("tomorrow")).toBe(24);
    expect(parseHoursUntil("today")).toBe(24);
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
});
