// Schema coverage for M22's step `callouts`/`blur`/`hold` additions.
import { describe, expect, it } from "vitest";
import { loadWalkthroughText, WalkthroughValidationError } from "../../src/walkthrough/loader.js";

const base = (stepsYaml: string) => `
walkthrough: add-competitor
title: Add a new competitor
steps:
${stepsYaml}
`;

describe("walkthrough schema: callouts/blur", () => {
  it("accepts a box-pinned callout with a label", () => {
    const wf = loadWalkthroughText(
      base(`  - do: click "Save" button
    callouts:
      - id: c1
        box: { x: 10, y: 20, w: 30, h: 40 }
        label: Click here
`),
      "fixture.yaml",
    );
    expect(wf.steps[0].callouts).toEqual([{ id: "c1", box: { x: 10, y: 20, w: 30, h: 40 }, label: "Click here" }]);
  });

  it("accepts a target-pinned callout with no label", () => {
    const wf = loadWalkthroughText(
      base(`  - do: click "Save" button
    callouts:
      - id: c1
        target: { role: button, name: Save }
`),
      "fixture.yaml",
    );
    expect(wf.steps[0].callouts).toEqual([{ id: "c1", target: { role: "button", name: "Save" } }]);
  });

  it("rejects a callout with both target and box", () => {
    expect(() =>
      loadWalkthroughText(
        base(`  - do: click "Save" button
    callouts:
      - id: c1
        target: { role: button }
        box: { x: 0, y: 0, w: 1, h: 1 }
`),
        "fixture.yaml",
      ),
    ).toThrow(WalkthroughValidationError);
  });

  it("rejects a callout with neither target nor box", () => {
    expect(() =>
      loadWalkthroughText(
        base(`  - do: click "Save" button
    callouts:
      - id: c1
`),
        "fixture.yaml",
      ),
    ).toThrow(WalkthroughValidationError);
  });

  it("accepts a blur box (no label field) and multiple entries", () => {
    const wf = loadWalkthroughText(
      base(`  - do: click "Save" button
    blur:
      - id: b1
        box: { x: 0, y: 0, w: 100, h: 20 }
      - id: b2
        target: { label: Email }
`),
      "fixture.yaml",
    );
    expect(wf.steps[0].blur).toEqual([
      { id: "b1", box: { x: 0, y: 0, w: 100, h: 20 } },
      { id: "b2", target: { label: "Email" } },
    ]);
  });

  it("still accepts hold (M16) alongside callouts/blur", () => {
    const wf = loadWalkthroughText(
      base(`  - do: click "Save" button
    hold: 1.5
    callouts:
      - id: c1
        box: { x: 0, y: 0, w: 1, h: 1 }
`),
      "fixture.yaml",
    );
    expect(wf.steps[0].hold).toBe(1.5);
    expect(wf.steps[0].callouts).toHaveLength(1);
  });

  it("a step with no callouts/blur stays backwards compatible", () => {
    const wf = loadWalkthroughText(base(`  - do: click "Save" button\n`), "fixture.yaml");
    expect(wf.steps[0].callouts).toBeUndefined();
    expect(wf.steps[0].blur).toBeUndefined();
  });
});
