import { describe, expect, it } from "vitest";
import { UnconfiguredSmsSender, assertSafePhoneNumber } from "../src/integrations/sms-sender.js";

describe("assertSafePhoneNumber", () => {
  it("accepts a plain E.164 number", () => {
    expect(assertSafePhoneNumber("+15551234567")).toBe("+15551234567");
  });

  it("trims whitespace", () => {
    expect(assertSafePhoneNumber("  +15551234567  ")).toBe("+15551234567");
  });

  it("rejects a number with no leading +", () => {
    expect(() => assertSafePhoneNumber("15551234567")).toThrow(/does not look like/);
  });

  it("rejects a number with a leading zero after the +", () => {
    expect(() => assertSafePhoneNumber("+05551234567")).toThrow(/does not look like/);
  });

  it("rejects non-digit characters", () => {
    expect(() => assertSafePhoneNumber("+1 (555) 123-4567")).toThrow(/does not look like/);
  });

  it("rejects an empty string", () => {
    expect(() => assertSafePhoneNumber("")).toThrow(/does not look like/);
  });
});

describe("UnconfiguredSmsSender", () => {
  it("reports it cannot send", () => {
    const sender = new UnconfiguredSmsSender();
    expect(sender.canSend).toBe(false);
  });

  it("refuses to send rather than pretending", async () => {
    const sender = new UnconfiguredSmsSender();
    await expect(sender.send()).rejects.toThrow(/no SMS transport is configured/);
  });
});
