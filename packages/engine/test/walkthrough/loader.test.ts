import { describe, expect, it } from "vitest";
import { loadWalkthroughText, WalkthroughValidationError } from "../../src/walkthrough/index.js";

const PLAIN_WORDS_EXAMPLE = `
walkthrough: add-competitor
title: Add a new competitor
for: office-staff
start: { signed_in_as: office-staff, page: /competitors }
steps:
  - do: click "Add competitor" button
    say: Start by selecting Add competitor.
    page_text: Select **Add competitor** at the top right.
  - do: fill "First name" with "Jordan"
    say: Type their first name.
  - do: click "Save" button
    check: text "Competitor added" is visible
    say: Save, and they're ready to enter a class.
`;

describe("loadWalkthroughText", () => {
  it("loads the plain-words example from scope.md", () => {
    const wt = loadWalkthroughText(PLAIN_WORDS_EXAMPLE);
    expect(wt.walkthrough).toBe("add-competitor");
    expect(wt.start?.signed_in_as).toBe("office-staff");
    expect(wt.steps).toHaveLength(3);
    expect(wt.steps[0].actions).toEqual([
      { do: "click", target: { role: "button", name: "Add competitor" } },
    ]);
    expect(wt.steps[2].actions).toEqual([
      { do: "click", target: { role: "button", name: "Save" } },
      { do: "expect", target: { text: "Competitor added" } },
    ]);
  });

  it("rejects a file with no steps and reports a short message", () => {
    expect(() => loadWalkthroughText("walkthrough: x\ntitle: X\nsteps: []\n")).toThrow(
      WalkthroughValidationError,
    );
  });

  it("rejects an unknown top-level field and reports its line", () => {
    const text = [
      "walkthrough: x",
      "title: X",
      "notAField: true",
      "steps:",
      "  - do: click \"Save\" button",
    ].join("\n");
    expect(() => loadWalkthroughText(text, "bad.yaml")).toThrow(WalkthroughValidationError);
    try {
      loadWalkthroughText(text, "bad.yaml");
    } catch (err) {
      const e = err as WalkthroughValidationError;
      expect(e.errors[0].file).toBe("bad.yaml");
      expect(e.message).toMatch(/bad\.yaml/);
    }
  });

  it("rejects a step with both `do` and `actions:` (bug: both ran, actions additively)", () => {
    const text = [
      "walkthrough: x",
      "title: X",
      "steps:",
      "  - do: click \"Save\" button",
      "    actions:",
      "      - do: click",
      "        target: { role: button, name: Save }",
    ].join("\n");
    expect(() => loadWalkthroughText(text, "bad.yaml")).toThrow(WalkthroughValidationError);
    try {
      loadWalkthroughText(text, "bad.yaml");
    } catch (err) {
      expect((err as WalkthroughValidationError).message).toMatch(/do.*check.*actions|actions.*do.*check/i);
    }
  });

  it("rejects a step with both `check` and `actions:`", () => {
    const text = [
      "walkthrough: x",
      "title: X",
      "steps:",
      "  - check: text \"Saved\" is visible",
      "    actions:",
      "      - do: expect",
      "        target: { text: Saved }",
    ].join("\n");
    expect(() => loadWalkthroughText(text, "bad.yaml")).toThrow(WalkthroughValidationError);
  });

  it("rejects malformed YAML", () => {
    expect(() => loadWalkthroughText("walkthrough: [unterminated")).toThrow(
      WalkthroughValidationError,
    );
  });

  it("rejects a walkthrough id that isn't a slug (used as a path segment downstream)", () => {
    const text = [
      "walkthrough: Add Competitor!",
      "title: X",
      "steps:",
      '  - do: click "Save" button',
    ].join("\n");
    expect(() => loadWalkthroughText(text, "bad-id.yaml")).toThrow(WalkthroughValidationError);
    try {
      loadWalkthroughText(text, "bad-id.yaml");
    } catch (err) {
      const e = err as WalkthroughValidationError;
      expect(e.message).toMatch(/slug/);
    }
  });

  it("accepts a lowercase-hyphenated slug id", () => {
    const text = [
      "walkthrough: add-competitor-2",
      "title: X",
      "steps:",
      '  - do: click "Save" button',
    ].join("\n");
    expect(loadWalkthroughText(text).walkthrough).toBe("add-competitor-2");
  });
});
