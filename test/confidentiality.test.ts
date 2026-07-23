import { describe, expect, it } from "vitest";
import { disclosurePolicyFor } from "../src/core/confidentiality.js";

describe("third-party confidentiality default", () => {
  it("never shares case details with a family member, even by default", () => {
    const policy = disclosurePolicyFor("family_or_third_party");
    expect(policy.mayShareCaseDetails).toBe(false);
    expect(policy.mayTakeMessage).toBe(true);
    expect(policy.scriptedResponse).toMatch(/can't share case details/);
  });

  it("allows case details to the client themself", () => {
    const policy = disclosurePolicyFor("existing_client");
    expect(policy.mayShareCaseDetails).toBe(true);
  });
});
