/**
 * §1 layer 3: firm-level config. Attorney assignments, hours, tone/branding,
 * sign-off rules. Never affects core enforcement (review gates, access
 * control, emergency escalation) — those are code paths, not config knobs.
 */
export interface AttorneyRecord {
  id: string;
  name: string;
  practiceAreaIds: string[];
}

export interface FirmConfig {
  firmName: string;
  attorneys: AttorneyRecord[];
  businessHours: { timezone: string; open: string; close: string; days: number[] };
  branding: { tone: "formal" | "warm" | "neutral"; greeting: string };
  /** e.g. "two-party-consent" for recording disclosure — see confidentiality.ts callers. */
  jurisdictionRecordingConsent: "one-party-consent" | "two-party-consent";
}
