import { describe, expect, it } from "vitest";
import { buildIcsCalendar, escapeIcsText, foldIcsLine, formatIcsDate, formatIcsDateTime } from "../src/core/ics.js";

/** RFC 5545 unfolding: a CRLF followed by one space or tab is removed. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
}

describe("escapeIcsText", () => {
  it("escapes the characters a parser would otherwise act on", () => {
    expect(escapeIcsText("Smith, Jones; and \\ partners")).toBe("Smith\\, Jones\\; and \\\\ partners");
  });

  it("turns newlines into \\n and drops other control characters", () => {
    expect(escapeIcsText("line one\r\nline two\nthree\u0007")).toBe("line one\\nline two\\nthree");
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line alone", () => {
    expect(foldIcsLine("SUMMARY:Arraignment")).toBe("SUMMARY:Arraignment");
  });

  it("keeps every physical line within 75 octets and unfolds back to the original", () => {
    const line = `DESCRIPTION:${"Muñoz — señora Ñúñez ✓ ".repeat(12)}`;
    const folded = foldIcsLine(line);
    for (const physical of folded.split("\r\n")) {
      expect(new TextEncoder().encode(physical).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  it("never splits a multi-byte character across lines", () => {
    // 74 ASCII octets then a three-byte character: it can't fit on line one.
    const line = `${"x".repeat(74)}✓tail`;
    const [first, second] = foldIcsLine(line).split("\r\n");
    expect(first).toBe("x".repeat(74));
    expect(second).toBe(" ✓tail");
  });
});

describe("date formatting", () => {
  it("writes timestamps in UTC", () => {
    expect(formatIcsDateTime("2026-11-23T15:40:05-05:00")).toBe("20261123T204005Z");
  });

  it("writes dates without separators and refuses anything else", () => {
    expect(formatIcsDate("2026-02-28")).toBe("20260228");
    expect(() => formatIcsDate("28/02/2026")).toThrow();
    expect(() => formatIcsDateTime("not a time")).toThrow();
  });
});

describe("buildIcsCalendar", () => {
  const now = new Date("2026-11-23T12:00:00Z");

  it("produces a CRLF-only calendar with the required properties", () => {
    const ics = buildIcsCalendar({ prodId: "-//Docket//Test//EN", name: "Docket", now, events: [] });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = unfold(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//Docket//Test//EN");
    expect(lines).toContain("X-WR-CALNAME:Docket");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("ends an all-day event the next day, as the spec's exclusive end requires", () => {
    const lines = unfold(
      buildIcsCalendar({ prodId: "p", now, events: [{ uid: "a@x", summary: "Deadline", start: { date: "2026-12-31" }, transparent: true }] }),
    );
    expect(lines).toContain("DTSTART;VALUE=DATE:20261231");
    expect(lines).toContain("DTEND;VALUE=DATE:20270101");
    expect(lines).toContain("TRANSP:TRANSPARENT");
    expect(lines).toContain("DTSTAMP:20261123T120000Z");
  });

  it("writes a timed event in UTC with its end, and escapes its text", () => {
    const lines = unfold(
      buildIcsCalendar({
        prodId: "p",
        now,
        events: [
          {
            uid: "b@x",
            summary: "Consultation — m-1, with Ada",
            description: "Line one\nLine two",
            start: { dateTime: "2026-12-01T15:00:00Z" },
            end: { dateTime: "2026-12-01T15:30:00Z" },
            status: "CONFIRMED",
            alarmBefore: "PT1H",
          },
        ],
      }),
    );
    expect(lines).toContain("DTSTART:20261201T150000Z");
    expect(lines).toContain("DTEND:20261201T153000Z");
    expect(lines).toContain("SUMMARY:Consultation — m-1\\, with Ada");
    expect(lines).toContain("DESCRIPTION:Line one\\nLine two");
    expect(lines).toContain("TRIGGER:-PT1H");
  });

  it("puts no reminder on a cancelled event", () => {
    const ics = buildIcsCalendar({
      prodId: "p",
      now,
      events: [{ uid: "c@x", summary: "CANCELLED", start: { dateTime: "2026-12-01T15:00:00Z" }, status: "CANCELLED", alarmBefore: "PT1H" }],
    });
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).not.toContain("VALARM");
  });

  it("refuses a reminder that isn't a duration rather than writing a broken file", () => {
    for (const bad of ["1 day", "P", "PT", "-P1D"]) {
      expect(() =>
        buildIcsCalendar({ prodId: "p", now, events: [{ uid: "d@x", summary: "x", start: { date: "2026-12-01" }, alarmBefore: bad }] }),
      ).toThrow();
    }
  });
});
