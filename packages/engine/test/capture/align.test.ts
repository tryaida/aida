// M43b (decision 40): lines a device's (possibly filtered, device-only steps skipped)
// manifest/validation arrays up against the walkthrough's own step positions by `stepIndex`.
import { describe, expect, it } from "vitest";
import { alignManifestToSteps } from "../../src/capture/align.js";

interface Fake {
  stepIndex?: number;
  label: string;
}

describe("alignManifestToSteps", () => {
  it("aligns every entry by its own stepIndex when every entry has one", () => {
    const steps: Fake[] = [{ stepIndex: 0, label: "a" }, { stepIndex: 2, label: "c" }];
    const aligned = alignManifestToSteps(steps, 3);
    expect(aligned[0]).toEqual({ mStep: steps[0], index: 0 });
    expect(aligned[1]).toBeUndefined();
    expect(aligned[2]).toEqual({ mStep: steps[1], index: 1 });
  });

  it("falls back to array position when stepIndex is never set (a pre-M43a manifest)", () => {
    const steps: Fake[] = [{ label: "a" }, { label: "b" }];
    const aligned = alignManifestToSteps(steps, 2);
    expect(aligned[0]).toEqual({ mStep: steps[0], index: 0 });
    expect(aligned[1]).toEqual({ mStep: steps[1], index: 1 });
  });

  it("keeps the manifest array's own position (not stepIndex) as `index`, for a parallel array like validation.steps", () => {
    const steps: Fake[] = [{ stepIndex: 0, label: "a" }, { stepIndex: 3, label: "d" }];
    const aligned = alignManifestToSteps(steps, 4);
    // "d" is the *second* manifest entry (index 1), even though it's walkthrough step 4.
    expect(aligned[3]?.index).toBe(1);
  });

  it("drops an out-of-range stepIndex rather than throwing", () => {
    const steps: Fake[] = [{ stepIndex: 5, label: "oops" }];
    const aligned = alignManifestToSteps(steps, 2);
    expect(aligned).toEqual([undefined, undefined]);
  });

  it("returns an array of exactly totalSteps length, undefined where nothing ran", () => {
    const aligned = alignManifestToSteps<Fake>([], 3);
    expect(aligned).toEqual([undefined, undefined, undefined]);
  });
});
