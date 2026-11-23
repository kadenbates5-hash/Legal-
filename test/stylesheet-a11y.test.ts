import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Accessibility rules that live in the stylesheets, pinned because every
 * one of them was broken once without any test noticing: each looked fine
 * with a mouse and was only found by tabbing through the app.
 */
const PUBLIC = join(__dirname, "..", "src", "review-ui", "public");
const SHEETS = ["app.css", "login.css", "book.css"];

function rules(file: string): Array<{ selectors: string[]; body: string }> {
  const css = readFileSync(join(PUBLIC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // Innermost blocks only, which is every style rule, including those
  // inside @media.
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean),
    body: m[2]!,
  }));
}

describe("stylesheet accessibility rules", () => {
  it.each(SHEETS)("%s: anything reset with `all: unset` gets its focus ring back", (sheet) => {
    // `all: unset` wipes the browser's focus outline along with everything
    // else; that's how every button and binder tab once lost theirs.
    const all = rules(sheet);
    const focusVisible = new Set(all.flatMap((r) => r.selectors).filter((s) => s.endsWith(":focus-visible")));
    const unset = all.filter((r) => /\ball:\s*unset\b/.test(r.body)).flatMap((r) => r.selectors);
    for (const selector of unset) {
      expect(focusVisible, `${sheet}: '${selector}' resets with all: unset but has no :focus-visible rule`).toContain(`${selector}:focus-visible`);
    }
  });

  it("gives a date field a ring when it's reached by keyboard", () => {
    // Tabbing into a date field focuses its day/month/year part inside the
    // control: Chromium then matches :focus-within, not :focus.
    const app = rules("app.css").flatMap((r) => r.selectors);
    expect(app).toContain(".field input:focus-within");
    const book = rules("book.css").flatMap((r) => r.selectors);
    expect(book).toContain(".book-card input:focus-within");
  });

  it("doesn't style a list nested in a row as a clickable row of its own", () => {
    const reset = rules("app.css").find((r) => r.selectors.includes("ul.list li li"));
    expect(reset?.body).toMatch(/cursor:\s*inherit/);
  });

  it.each(["app.css", "login.css"])("%s: [hidden] wins over a display set elsewhere", (sheet) => {
    const hidden = rules(sheet).find((r) => r.selectors.includes("[hidden]"));
    expect(hidden?.body).toMatch(/display:\s*none\s*!important/);
  });
});
