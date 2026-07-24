import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type FirmConfig } from "../src/config/firm-config.js";

function makeConfig(overrides?: Partial<FirmConfig["businessHours"]>): FirmConfig {
  return {
    firmName: "Test Firm",
    attorneys: [],
    businessHours: {
      timezone: "America/New_York",
      open: "09:00",
      close: "17:00",
      days: [1, 2, 3, 4, 5], // Mon-Fri
      ...overrides,
    },
    branding: { tone: "warm", greeting: "Welcome to Test Firm." },
    jurisdictionRecordingConsent: "two-party-consent",
  };
}

describe("isWithinBusinessHours", () => {
  it("is true for a weekday during business hours", () => {
    // Wednesday 2026-07-22 is a Wednesday; 15:00 UTC = 11:00 America/New_York (EDT, UTC-4)
    const config = makeConfig();
    const at = new Date("2026-07-22T15:00:00Z");
    expect(isWithinBusinessHours(config, at)).toBe(true);
  });

  it("is false before opening", () => {
    const config = makeConfig();
    // 10:00 UTC = 06:00 America/New_York — before 09:00 open
    const at = new Date("2026-07-22T10:00:00Z");
    expect(isWithinBusinessHours(config, at)).toBe(false);
  });

  it("is false after closing", () => {
    const config = makeConfig();
    // 22:00 UTC = 18:00 America/New_York — after 17:00 close
    const at = new Date("2026-07-22T22:00:00Z");
    expect(isWithinBusinessHours(config, at)).toBe(false);
  });

  it("is false on a weekend even during would-be business hours", () => {
    const config = makeConfig();
    // 2026-07-25 is a Saturday; 15:00 UTC = 11:00 America/New_York
    const at = new Date("2026-07-25T15:00:00Z");
    expect(isWithinBusinessHours(config, at)).toBe(false);
  });

  it("respects a firm's custom days array (e.g. open Saturdays, closed Mondays)", () => {
    const config = makeConfig({ days: [0, 2, 3, 4, 5, 6] }); // closed Monday
    const monday = new Date("2026-07-27T15:00:00Z"); // Monday
    const saturday = new Date("2026-07-25T15:00:00Z"); // Saturday
    expect(isWithinBusinessHours(config, monday)).toBe(false);
    expect(isWithinBusinessHours(config, saturday)).toBe(true);
  });
});
