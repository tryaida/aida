// Lines a capture's steps up against the walkthrough's own `steps` list by `ManifestStep.stepIndex`
// (M43a), never by array position: a device-only step (`devices:`) is skipped by the capture
// runner and so absent from a device's `manifest.steps`/`validation.steps` arrays, which makes
// positional indexing (`manifest.steps[i]` for `wf.steps[i]`) wrong as soon as any step is
// device-only. `validation.steps` is pushed in the same filtered loop as `manifest.steps`
// (capture/runner.ts), so it's always parallel to it by array position — never by `stepIndex`
// itself, which is why this returns the manifest array's own position alongside each match.
export interface AlignedStep<M> {
  mStep: M;
  /** This step's position in the array it came from (`manifest.steps`) — the same position
   * `validation.steps` (or any other array built in that same filtered loop) uses for it. */
  index: number;
}

/**
 * `wf.steps`-indexed (0-based, length `totalSteps`) lookup of each walkthrough step's capture
 * data: `aligned[j]` is the manifest step whose `stepIndex === j`, or undefined when that step
 * wasn't run on this device. Falls back to plain position (`manifestSteps[j]`) for a manifest
 * written before M43a, where `stepIndex` is never set and no step was ever filtered, so position
 * is exactly right.
 */
export function alignManifestToSteps<M extends { stepIndex?: number }>(manifestSteps: M[], totalSteps: number): (AlignedStep<M> | undefined)[] {
  const out: (AlignedStep<M> | undefined)[] = new Array(totalSteps).fill(undefined);
  manifestSteps.forEach((mStep, index) => {
    const idx = mStep.stepIndex ?? index;
    if (idx >= 0 && idx < totalSteps) out[idx] = { mStep, index };
  });
  return out;
}
