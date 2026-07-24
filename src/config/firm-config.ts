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

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Timezone-aware business-hours check — `businessHours.timezone` is an
 * IANA zone name, `open`/`close` are `"HH:MM"` in that zone, `days` are
 * weekday indices (0 = Sunday). Never used to gate emergency escalation or
 * any core behavior — only the receptionist's after-hours notice script,
 * consistent with "never affects core enforcement" above.
 */
export function isWithinBusinessHours(config: FirmConfig, at: Date = new Date()): boolean {
  const { timezone, open, close, days } = config.businessHours;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const weekday = WEEKDAY_INDEX[weekdayName];

  if (weekday === undefined || !days.includes(weekday)) return false;

  const nowMinutes = hour * 60 + minute;
  const [openHour, openMinute] = open.split(":").map(Number);
  const [closeHour, closeMinute] = close.split(":").map(Number);
  const openMinutes = (openHour ?? 0) * 60 + (openMinute ?? 0);
  const closeMinutes = (closeHour ?? 0) * 60 + (closeMinute ?? 0);

  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}
