// M42a (decision 39): alt text for a step's screenshot.
import { describe, expect, it } from "vitest";
import { stepAltText } from "../../src/pages/alt-text.js";
import type { Step } from "../../src/walkthrough/index.js";

function step(overrides: Partial<Step> = {}): Step {
  return { id: "s1", actions: [], ...overrides };
}

describe("stepAltText", () => {
  it("never empty and never just the title, even with no instruction and no callouts", () => {
    const alt = stepAltText(step({ title: "Save the order" }), 3, undefined, undefined);
    expect(alt.length).toBeGreaterThan(0);
    expect(alt).not.toBe("Save the order");
    expect(alt).toContain("Save the order");
  });

  it("describes the step's instruction with markdown stripped", () => {
    // Already display-resolved (walkthrough/display.ts runs before this in every real caller —
    // build.ts hands buildStepBlock/stepAltText a `displayWalkthrough()`'d step), so page_text
    // here is the reader-facing text verbatim, same as the page body prints.
    const alt = stepAltText(step({ title: "Open the order", page_text: "Click **Open** on Acme's order." }), 2);
    expect(alt).not.toMatch(/\*\*/);
    expect(alt).toContain("Acme's order");
  });

  it("resolves {{data}} and drops {{run.*}} in words built from actions, same as describeActions", () => {
    const alt = stepAltText(
      step({
        title: "Open the order",
        actions: [{ do: "click", target: { role: "button", name: "{{customer}}'s order {{run.id}}" } }],
      }),
      2,
      undefined,
      { customer: "Acme" },
    );
    expect(alt).toContain("Acme's order");
    expect(alt).not.toContain("run.id");
    expect(alt).not.toMatch(/\{\{/);
  });

  it("names numbered callouts", () => {
    const withOne = stepAltText(
      step({ title: "Settings", callouts: [{ id: "c1", box: { x: 0, y: 0, w: 1, h: 1 }, label: "Save button" }] }),
      1,
    );
    expect(withOne).toContain("A numbered callout marks Save button.");

    const withTwo = stepAltText(
      step({
        title: "Settings",
        callouts: [
          { id: "c1", box: { x: 0, y: 0, w: 1, h: 1 }, label: "Save button" },
          { id: "c2", box: { x: 0, y: 0, w: 1, h: 1 }, label: "Cancel button" },
        ],
      }),
      1,
    );
    expect(withTwo).toContain("Numbered callouts mark Save button and Cancel button.");
  });

  it("uses a manifest `seen` heading over the step title when one looks like a screen name", () => {
    const alt = stepAltText(step({ title: "Step 1", page_text: "Click **Save**." }), 1, { seen: ["Payment settings", "save"] });
    expect(alt).toContain("Screenshot of Payment settings");
  });

  it("falls back to the step title when manifest `seen` has nothing heading-like", () => {
    const alt = stepAltText(step({ title: "Payment settings", page_text: "Click **Save**." }), 1, { seen: ["save."] });
    expect(alt).toContain("Screenshot of Payment settings");
  });

  it("stays within the ~250 char cap", () => {
    const longLabel = "a".repeat(300);
    const alt = stepAltText(step({ title: "Step", callouts: [{ id: "c1", box: { x: 0, y: 0, w: 1, h: 1 }, label: longLabel }] }), 1);
    expect(alt.length).toBeLessThanOrEqual(250);
  });

  it("falls back to a step-number sentence when there's no title, instruction or callout", () => {
    const alt = stepAltText(step(), 4);
    expect(alt).toContain("step 4");
  });

  it("replaces [ and ] so the alt text can't break out of markdown's ![alt](src)", () => {
    const alt = stepAltText(step({ title: "Settings", page_text: "the plan marked [Pro]." }), 1);
    expect(alt).not.toMatch(/[[\]]/);
    expect(alt).toContain("the plan marked (Pro)");
  });

  it("strips newlines from the final alt text", () => {
    const alt = stepAltText(
      step({ title: "Settings", callouts: [{ id: "c1", box: { x: 0, y: 0, w: 1, h: 1 }, label: "a\nb" }] }),
      1,
    );
    expect(alt).not.toMatch(/\n/);
  });
});
