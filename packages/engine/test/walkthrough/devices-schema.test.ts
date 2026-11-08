import { describe, expect, it } from "vitest";
import { loadWalkthroughText, WalkthroughValidationError } from "../../src/walkthrough/index.js";

const base = `
walkthrough: add-competitor
title: Add a competitor
steps:
  - id: open
    do: go to /competitors
  - id: save
    do: click "Save" button
`;

function errorsOf(yaml: string): string[] {
  try {
    loadWalkthroughText(yaml, "t.yaml");
  } catch (err) {
    if (err instanceof WalkthroughValidationError) return err.errors.map((e) => `${e.path}: ${e.message}`);
    throw err;
  }
  return [];
}

describe("walkthrough/step devices", () => {
  it("accepts a plain devices list on the walkthrough and a step", () => {
    const wt = loadWalkthroughText(`${base}\ndevices: [desktop, phone]\n`.replace("  - id: open\n    do: go to /competitors\n", "  - id: open\n    do: go to /competitors\n    devices: [phone]\n"));
    expect(wt.devices).toEqual(["desktop", "phone"]);
    expect(wt.steps[0].devices).toEqual(["phone"]);
    expect(wt.steps[1].devices).toBeUndefined();
  });

  it("leaves devices off a walkthrough that doesn't set it", () => {
    const wt = loadWalkthroughText(base);
    expect("devices" in wt).toBe(false);
    expect(wt.steps[0].devices).toBeUndefined();
  });

  it("rejects an unknown device", () => {
    expect(errorsOf(`${base}\ndevices: [desktop, tablet]\n`).join()).toMatch(/invalid|phone|desktop/i);
  });

  it("rejects an empty devices list", () => {
    expect(errorsOf(`${base}\ndevices: []\n`).join()).toContain("at least one device");
  });

  it("rejects a duplicated device", () => {
    expect(errorsOf(`${base}\ndevices: [phone, phone]\n`).join()).toContain("listed twice");
  });

  it("rejects a step device that isn't in the walkthrough's own devices", () => {
    const yaml = `${base}\ndevices: [desktop]\n`.replace(
      "  - id: save\n    do: click \"Save\" button\n",
      "  - id: save\n    do: click \"Save\" button\n    devices: [phone]\n",
    );
    expect(errorsOf(yaml).join()).toContain("isn't in the walkthrough's devices");
  });

  it("rejects a walkthrough device with no step that runs on it", () => {
    // Every step says devices: [desktop] explicitly, so "phone" never gets a step.
    const yaml = `${base}\ndevices: [desktop, phone]\n`
      .replace("  - id: open\n    do: go to /competitors\n", "  - id: open\n    do: go to /competitors\n    devices: [desktop]\n")
      .replace("  - id: save\n    do: click \"Save\" button\n", "  - id: save\n    do: click \"Save\" button\n    devices: [desktop]\n");
    expect(errorsOf(yaml).join()).toContain("no step runs on it");
  });

  it("accepts a step devices list that's a subset of the walkthrough's, with every declared device covered", () => {
    const yaml = `${base}\ndevices: [desktop, phone]\n`.replace(
      "  - id: open\n    do: go to /competitors\n",
      "  - id: open\n    do: go to /competitors\n    devices: [desktop]\n",
    );
    expect(errorsOf(yaml)).toEqual([]);
  });

  it("doesn't check step devices against config/brief-resolved devices when the walkthrough itself sets none", () => {
    // No top-level `devices:` here, so the schema can't know the resolved device list yet
    // (that's config/brief, at build time) — a step naming "phone" alone must still validate.
    const yaml = base.replace("  - id: open\n    do: go to /competitors\n", "  - id: open\n    do: go to /competitors\n    devices: [phone]\n");
    expect(errorsOf(yaml)).toEqual([]);
  });
});
