import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setStepActions, setStepField, reorderSteps, removeStep, insertStep } from "../../src/edit/steps.js";
import { EditValidationError } from "../../src/edit/types.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { cleanupTmpDirs, setupHelpApp } from "./helpers.js";

afterEach(() => {
  cleanupTmpDirs();
});

describe("setStepField", () => {
  it("edits one field and preserves comments/formatting elsewhere", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    const result = setStepField(walkthroughFile, "check-show", "say", "Updated narration for this step.", { by: "person" });

    expect(result.after).toBe("Updated narration for this step.");
    const after = readFileSync(walkthroughFile, "utf8");
    expect(after).toContain("Updated narration for this step.");

    // Untouched content (other steps, verifiedAgainst routes, data) stays byte-identical.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    // Lines describing verifiedAgainst routes are unaffected by the edit.
    const routesLine = beforeLines.find((l) => l.includes("/dashboard/competitors"));
    expect(routesLine).toBeTruthy();
    expect(afterLines).toContain(routesLine);

    // The result still parses and validates.
    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")?.say).toBe("Updated narration for this step.");
    // Other steps are untouched.
    expect(wt.steps.find((s) => s.id === "open-competitors")?.say).toBe("Then open Competitors from the menu.");
  });

  it("rejects an edit that fails schema validation, and doesn't write the file", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    // `hold` must be a number — assigning a string makes the walkthrough invalid.
    expect(() => setStepField(walkthroughFile, "check-show", "hold", "not-a-number" as unknown as number)).toThrow(
      EditValidationError,
    );

    const after = readFileSync(walkthroughFile, "utf8");
    expect(after).toBe(before);
  });

  it("throws a clear error for an unknown step id", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => setStepField(walkthroughFile, "no-such-step", "say", "x")).toThrow(/no step with id/);
  });

  it("accepts a plain-words `do` locator fix, parsed through the walkthrough parser", () => {
    const { walkthroughFile } = setupHelpApp();

    setStepField(walkthroughFile, "open-competitors", "do", 'click "Competitors" link', { by: "agent" });

    const wt = loadWalkthroughFile(walkthroughFile);
    const step = wt.steps.find((s) => s.id === "open-competitors");
    expect(step?.actions).toEqual(
      expect.arrayContaining([{ do: "click", target: { role: "link", name: "Competitors" } }]),
    );
  });

  it("rejects an unrecognised plain-words `do` string, and doesn't write the file", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    expect(() => setStepField(walkthroughFile, "open-competitors", "do", "do something weird")).toThrow(
      EditValidationError,
    );

    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });

  it("accepts a plain-words `check` locator fix", () => {
    const { walkthroughFile } = setupHelpApp();

    setStepField(walkthroughFile, "open-competitors", "check", 'text "Competitors" is visible', { by: "agent" });

    const wt = loadWalkthroughFile(walkthroughFile);
    const step = wt.steps.find((s) => s.id === "open-competitors");
    expect(step?.actions).toEqual(expect.arrayContaining([{ do: "expect", target: { text: "Competitors" } }]));
  });

  it("clears a step's existing actions: when setting do (bug: the old actions kept running alongside the new do)", () => {
    const { walkthroughFile } = setupHelpApp();
    // open-competitors starts with only `actions:` (click + waitFor) — see the fixture.
    const beforeWt = loadWalkthroughFile(walkthroughFile);
    expect(beforeWt.steps.find((s) => s.id === "open-competitors")?.actions.length).toBeGreaterThan(1);

    setStepField(walkthroughFile, "open-competitors", "do", 'click "Competitors" link', { by: "agent" });

    const after = loadWalkthroughFile(walkthroughFile);
    const step = after.steps.find((s) => s.id === "open-competitors");
    // Only the action parsed from the new `do:` remains — the old actions: list is gone, not
    // concatenated with it.
    expect(step?.actions).toEqual([{ do: "click", target: { role: "link", name: "Competitors" } }]);

    // The raw YAML has no actions: key left on this step.
    const raw = readFileSync(walkthroughFile, "utf8");
    const stepBlock = raw.split("- id: open-competitors")[1].split("- id: search-first")[0];
    expect(stepBlock).not.toContain("actions:");
  });

  it("clears a step's existing actions: when setting check", () => {
    const { walkthroughFile } = setupHelpApp();

    setStepField(walkthroughFile, "open-competitors", "check", 'text "Competitors" is visible', { by: "agent" });

    const after = loadWalkthroughFile(walkthroughFile);
    const step = after.steps.find((s) => s.id === "open-competitors");
    expect(step?.actions).toEqual([{ do: "expect", target: { text: "Competitors" } }]);
  });
});

describe("setStepActions", () => {
  it("replaces a step's actions list with a schema-validated structured list", () => {
    const { walkthroughFile } = setupHelpApp();
    const newActions = [{ do: "click", target: { role: "button", name: "Create Competitor", exact: true } }];

    const result = setStepActions(walkthroughFile, "check-show", newActions, { by: "agent" });

    expect(result.after).toEqual(newActions);
    const wt = loadWalkthroughFile(walkthroughFile);
    expect(wt.steps.find((s) => s.id === "check-show")?.actions).toEqual(newActions);
  });

  it("rejects an actions array that fails the Action schema, and doesn't write the file", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");

    expect(() =>
      setStepActions(walkthroughFile, "check-show", [{ do: "not-a-real-action" }], { by: "agent" }),
    ).toThrow(EditValidationError);

    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });

  it("rejects a non-array actions value", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => setStepActions(walkthroughFile, "check-show", { not: "an array" }, { by: "agent" })).toThrow(
      EditValidationError,
    );
  });

  it("throws a clear error for an unknown step id", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => setStepActions(walkthroughFile, "no-such-step", [])).toThrow(/no step with id/);
  });

  it("clears a step's existing do/check when setting actions (so the schema's do/check+actions ban never trips)", () => {
    const { walkthroughFile } = setupHelpApp();
    setStepField(walkthroughFile, "open-competitors", "do", 'click "Competitors" link', { by: "agent" });

    const newActions = [{ do: "click", target: { role: "link", name: "Competitors", exact: true } }];
    setStepActions(walkthroughFile, "open-competitors", newActions, { by: "agent" });

    const after = loadWalkthroughFile(walkthroughFile);
    expect(after.steps.find((s) => s.id === "open-competitors")?.actions).toEqual(newActions);

    const raw = readFileSync(walkthroughFile, "utf8");
    const stepBlock = raw.split("- id: open-competitors")[1].split("- id: search-first")[0];
    // Step-level `do:`/`check:` are indented 4 spaces; only an action's own `do:` field
    // (indented 6, as part of `actions:`) should remain.
    expect(stepBlock).not.toMatch(/\n {4}do:/);
    expect(stepBlock).not.toMatch(/\n {4}check:/);
  });
});

describe("reorderSteps", () => {
  it("reorders steps to match the given id order", () => {
    const { walkthroughFile } = setupHelpApp();
    const wt = loadWalkthroughFile(walkthroughFile);
    const ids = wt.steps.map((s) => s.id!);
    const reversed = [...ids].reverse();

    reorderSteps(walkthroughFile, reversed, { by: "person" });

    const after = loadWalkthroughFile(walkthroughFile);
    expect(after.steps.map((s) => s.id)).toEqual(reversed);
  });

  it("rejects an order that doesn't contain exactly the current step ids", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => reorderSteps(walkthroughFile, ["check-show", "open-competitors"])).toThrow(
      /must contain exactly/,
    );
  });
});

describe("removeStep", () => {
  it("removes a step and keeps the rest valid", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = loadWalkthroughFile(walkthroughFile);
    const countBefore = before.steps.length;

    removeStep(walkthroughFile, "done", { by: "person" });

    const after = loadWalkthroughFile(walkthroughFile);
    expect(after.steps).toHaveLength(countBefore - 1);
    expect(after.steps.find((s) => s.id === "done")).toBeUndefined();
  });
});

describe("insertStep", () => {
  it("inserts a new step after an anchor id", () => {
    const { walkthroughFile } = setupHelpApp();
    const countBefore = loadWalkthroughFile(walkthroughFile).steps.length;

    insertStep(
      walkthroughFile,
      { after: "open-competitors", id: "confirm-page", do: 'click "Add New Competitor" button', say: "Click it." },
      { by: "agent" },
    );

    const after = loadWalkthroughFile(walkthroughFile);
    expect(after.steps).toHaveLength(countBefore + 1);
    const ids = after.steps.map((s) => s.id);
    expect(ids.indexOf("confirm-page")).toBe(ids.indexOf("open-competitors") + 1);
    const step = after.steps.find((s) => s.id === "confirm-page");
    expect(step?.say).toBe("Click it.");
    expect(step?.actions).toEqual(
      expect.arrayContaining([{ do: "click", target: { role: "button", name: "Add New Competitor" } }]),
    );
  });

  it("inserts a new step with title, chapter and a full-page camera", () => {
    const { walkthroughFile } = setupHelpApp();
    insertStep(
      walkthroughFile,
      {
        after: "open-competitors",
        id: "with-extras",
        do: 'click "Add New Competitor" button',
        title: "Open the form",
        chapter: "Add the competitor",
        camera: "full",
      },
      { by: "agent" },
    );
    const after = loadWalkthroughFile(walkthroughFile);
    const step = after.steps.find((s) => s.id === "with-extras");
    expect(step?.title).toBe("Open the form");
    expect(step?.chapter).toBe("Add the competitor");
    expect(step?.camera).toBe("full");
  });

  it("inserts a new step with a focused camera object", () => {
    const { walkthroughFile } = setupHelpApp();
    insertStep(
      walkthroughFile,
      {
        after: "open-competitors",
        id: "with-camera-focus",
        do: 'click "Add New Competitor" button',
        camera: { focus: { role: "button", name: "Add New Competitor" }, zoom: 1.25, align: "top" },
      },
      { by: "agent" },
    );
    const after = loadWalkthroughFile(walkthroughFile);
    const step = after.steps.find((s) => s.id === "with-camera-focus");
    expect(step?.camera).toEqual({ focus: { role: "button", name: "Add New Competitor" }, zoom: 1.25, align: "top" });
  });

  it("inserts a new step before an anchor id", () => {
    const { walkthroughFile } = setupHelpApp();
    insertStep(walkthroughFile, { before: "search-first", id: "new-before", do: 'click "X" button' }, { by: "agent" });
    const after = loadWalkthroughFile(walkthroughFile);
    const ids = after.steps.map((s) => s.id);
    expect(ids.indexOf("new-before")).toBe(ids.indexOf("search-first") - 1);
  });

  it("inserts a new step at the start", () => {
    const { walkthroughFile } = setupHelpApp();
    insertStep(walkthroughFile, { atStart: true, id: "very-first", do: 'click "X" button' }, { by: "agent" });
    const after = loadWalkthroughFile(walkthroughFile);
    expect(after.steps[0].id).toBe("very-first");
  });

  it("rejects when zero or more than one of after/before/atStart is given", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => insertStep(walkthroughFile, { id: "x" })).toThrow(/exactly one/);
    expect(() =>
      insertStep(walkthroughFile, { after: "open-competitors", before: "search-first", id: "x" }),
    ).toThrow(/exactly one/);
  });

  it("rejects a duplicate step id, and doesn't write the file", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");
    expect(() => insertStep(walkthroughFile, { after: "open-competitors", id: "search-first" })).toThrow(
      /already exists/,
    );
    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });

  it("rejects an unknown anchor id", () => {
    const { walkthroughFile } = setupHelpApp();
    expect(() => insertStep(walkthroughFile, { after: "no-such-step", id: "x" })).toThrow(/no step with id/);
  });

  it("rejects an unparsable `do`, and doesn't write the file", () => {
    const { walkthroughFile } = setupHelpApp();
    const before = readFileSync(walkthroughFile, "utf8");
    expect(() =>
      insertStep(walkthroughFile, { after: "open-competitors", id: "new-step", do: "do something weird" }),
    ).toThrow(EditValidationError);
    expect(readFileSync(walkthroughFile, "utf8")).toBe(before);
  });
});
