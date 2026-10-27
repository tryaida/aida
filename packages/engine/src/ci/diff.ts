// Screenshot-diff detection for one walkthrough: compares freshly built page screenshots against
// the baseline (published) ones at `base`, writing before/after/diff PNGs for any step that
// changed. Split out of ci/run.ts so it's testable against a plain fixture git repo + tiny PNGs,
// with no capture/Playwright involved.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffPngBuffers } from "../capture/index.js";
import { buildDiffOverlay } from "./overlay.js";
import type { BaselineSource } from "./baseline.js";
import type { ChangedStep } from "./types.js";

export function writeChangedStep(
  outDir: string,
  walkthroughId: string,
  fileName: string,
  before: Buffer | undefined,
  after: Buffer,
  changeRatio: number,
  tolerance: number,
): ChangedStep {
  const dir = join(outDir, walkthroughId);
  mkdirSync(dir, { recursive: true });
  const beforePath = join(dir, `before-${fileName}`);
  const afterPath = join(dir, `after-${fileName}`);
  const diffPath = join(dir, `diff-${fileName}`);
  if (before) writeFileSync(beforePath, before);
  writeFileSync(afterPath, after);
  writeFileSync(diffPath, before ? buildDiffOverlay(before, after, tolerance) : after);
  return { step: fileName, before: before ? beforePath : "", after: afterPath, diff: diffPath, changeRatio };
}

/**
 * Compares `walkthroughId`'s freshly built page screenshots (`newFiles`, file names only, read
 * from `newScreenshotsDir`) against the baseline at `base`. Returns `undefined` when the baseline
 * has no screenshots for this walkthrough at all — a brand-new walkthrough, not a changed one.
 */
export function diffAgainstBaseline(
  walkthroughId: string,
  newScreenshotsDir: string,
  newFiles: string[],
  source: BaselineSource,
  tolerance: number,
  outDir: string,
): ChangedStep[] | undefined {
  const baselineIds = source.listWalkthroughIds();
  if (!baselineIds.includes(walkthroughId)) return undefined;

  const changed: ChangedStep[] = [];
  for (const fileName of newFiles) {
    const after = readFileSync(join(newScreenshotsDir, fileName));
    const before = source.getScreenshot(walkthroughId, fileName);
    if (!before) {
      // A step that didn't exist in the baseline at all — treat as fully changed, not "new
      // walkthrough" (the walkthrough itself has a baseline; this one step doesn't).
      changed.push(writeChangedStep(outDir, walkthroughId, fileName, undefined, after, 1, tolerance));
      continue;
    }
    const diff = diffPngBuffers(before, after, tolerance);
    if (diff.changedFraction > 0 || !diff.dimensionsMatch) {
      changed.push(writeChangedStep(outDir, walkthroughId, fileName, before, after, diff.changedFraction, tolerance));
    }
  }
  return changed;
}
