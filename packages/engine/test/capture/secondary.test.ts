// When a secondary device may be captured in a plan slot, and when its capture on disk may be
// used (capture/secondary.ts, decision 40).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSecondaryCapture, usableDeviceCapture, walkthroughChangesData } from "../../src/capture/secondary.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const readOnly: Walkthrough = { walkthrough: "look", title: "Look", steps: [{ id: "see", actions: [{ do: "expect", target: { text: "Hi" } }] }] };
const writes: Walkthrough = { ...readOnly, steps: [{ id: "save", actions: [{ do: "click", target: { text: "Save" } }] }] };
const adapter = { database: { url: async () => "postgres://127.0.0.1/x", query: async () => [], reset: async () => {} } } as never;

describe("walkthroughChangesData", () => {
  it("is true for a write step, leaves/clears, setup steps or a needs setup hook; false for a read-only walkthrough", () => {
    expect(walkthroughChangesData(readOnly, {})).toBe(false);
    expect(walkthroughChangesData(writes, {})).toBe(true);
    expect(walkthroughChangesData({ ...readOnly, leaves: ["x"] }, {})).toBe(true);
    expect(walkthroughChangesData({ ...readOnly, clears: ["x"] }, {})).toBe(true);
    expect(walkthroughChangesData({ ...readOnly, setup: { steps: readOnly.steps } }, {})).toBe(true);
    expect(walkthroughChangesData({ ...readOnly, needs: ["x"] }, { states: { x: { setup: async () => {} } } } as never)).toBe(true);
    expect(walkthroughChangesData({ ...readOnly, needs: ["x"] }, { states: { x: { check: async () => true } } } as never)).toBe(false);
  });
});

describe("planSecondaryCapture", () => {
  it("brackets a secondary with resets when one is allowed and the walkthrough changes data (or the slot resets anyway)", () => {
    expect(planSecondaryCapture(writes, adapter, { resetBefore: false, resetAllowed: true })).toEqual({ capture: true, reset: true });
    expect(planSecondaryCapture(readOnly, adapter, { resetBefore: true, resetAllowed: true })).toEqual({ capture: true, reset: true });
  });

  it("captures a read-only walkthrough's secondary without resets when none is wanted or allowed", () => {
    expect(planSecondaryCapture(readOnly, adapter, { resetBefore: false, resetAllowed: true })).toEqual({ capture: true, reset: false });
    expect(planSecondaryCapture(readOnly, {}, { resetBefore: false, resetAllowed: false })).toEqual({ capture: true, reset: false });
  });

  it("refuses a secondary for a walkthrough that changes data when no reset is possible, saying why", () => {
    const midChain = planSecondaryCapture(writes, adapter, { resetBefore: false, resetAllowed: false, cannotResetReason: "no reset: keeps the data p left" });
    expect(midChain).toEqual({ capture: false, reason: expect.stringMatching(/^needs a database reset between devices.*keeps the data p left/) });
    const noAdapter = planSecondaryCapture(writes, {}, { resetBefore: true, resetAllowed: true });
    expect(noAdapter).toEqual({ capture: false, reason: expect.stringMatching(/no database adapter/) });
  });
});

describe("usableDeviceCapture", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function capture(validation: Record<string, unknown> | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "aida-usable-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ workflow: "look", steps: [] }));
    if (validation) writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
    return dir;
  }

  it("is the capture only when its validation passed and doesn't say it wasn't captured", () => {
    expect(usableDeviceCapture(capture({ ok: true, steps: [] }))?.manifest).toMatchObject({ workflow: "look" });
    expect(usableDeviceCapture(capture({ ok: false, steps: [] }))).toBeUndefined();
    expect(usableDeviceCapture(capture({ ok: true, steps: [], notCaptured: "blocked" }))).toBeUndefined();
    expect(usableDeviceCapture(capture(undefined))).toBeUndefined();
  });
});
