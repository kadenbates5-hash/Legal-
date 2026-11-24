import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/**
 * The Conflicts panel's matter form rebuilds the whole party list from its
 * text boxes on every save, so anything a party line can't express is
 * deleted by saving. Related parties and notes used to be exactly that.
 * These run the page's own two functions, taken from app.js as written.
 */
const source = readFileSync(new URL("../src/review-ui/public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function partyToLine(");
const end = source.indexOf("function partiesToTextareas(");
const sandbox: { partyToLine?: (p: object) => string; lineToParty?: (l: string, r: string) => Record<string, string> } = {};
runInNewContext(`${source.slice(start, end)}; this.partyToLine = partyToLine; this.lineToParty = lineToParty;`, sandbox);
const { partyToLine, lineToParty } = sandbox as Required<typeof sandbox>;

describe("a party as one line of the matter form", () => {
  it("round-trips a name, email, phone and note", () => {
    const party = { name: "Dana Cole", role: "client", email: "dana@example.com", phone: "+15551234567", note: "prefers email" };
    const line = partyToLine(party);
    expect(line).toBe("Dana Cole <dana@example.com> [+15551234567] — prefers email");
    expect(lineToParty(line, "client")).toEqual(party);
  });

  it("keeps a note that has its own dash in it, and reads -- for —", () => {
    expect(lineToParty("Officer Pike — arresting officer — badge 114", "related")).toEqual({
      name: "Officer Pike",
      role: "related",
      note: "arresting officer — badge 114",
    });
    expect(lineToParty("Riley Shaw -- co-defendant", "related")).toEqual({ name: "Riley Shaw", role: "related", note: "co-defendant" });
  });

  it("leaves a hyphenated name alone", () => {
    expect(lineToParty("Ana Smith-Jones", "adverse")).toEqual({ name: "Ana Smith-Jones", role: "adverse" });
  });

  it("is saved from a related-parties box, so saving doesn't delete them", () => {
    expect(source).toMatch(/linesOf\("matterRelated"\)\.map\(\(line\) => lineToParty\(line, "related"\)\)/);
    expect(readFileSync(new URL("../src/review-ui/public/index.html", import.meta.url), "utf8")).toContain('id="matterRelated"');
  });
});
