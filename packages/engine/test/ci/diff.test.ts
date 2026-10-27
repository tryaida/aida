import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffAgainstBaseline } from "../../src/ci/diff.js";
import { resolveBaselineLookup, gitBaselineSource, diskBaselineSource } from "../../src/ci/baseline.js";
import { cleanupTmpDirs, commitScreenshot, makeBaselineRepo, solidPng, tmpDir } from "./helpers.js";

afterEach(cleanupTmpDirs);

function writeNewScreenshot(dir: string, fileName: string, bytes: Buffer): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), bytes);
}

describe("ci/diff diffAgainstBaseline (git source)", () => {
  it("returns undefined for a walkthrough with no baseline at all (new walkthrough)", () => {
    const { repo } = makeBaselineRepo();
    const source = gitBaselineSource(resolveBaselineLookup(join(repo, "public")), "HEAD");
    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", solidPng(2, 2, [1, 2, 3]));
    const outDir = tmpDir();

    const result = diffAgainstBaseline("brand-new", newDir, ["step-01.png"], source, 10, outDir);
    expect(result).toBeUndefined();
  });

  it("returns an empty array when the new screenshot is pixel-identical to the baseline", () => {
    const { repo } = makeBaselineRepo();
    const bytes = solidPng(4, 4, [50, 60, 70]);
    commitScreenshot(repo, "add-entry", "step-01.png", bytes);
    const source = gitBaselineSource(resolveBaselineLookup(join(repo, "public")), "HEAD");

    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", bytes);
    const outDir = tmpDir();

    const result = diffAgainstBaseline("add-entry", newDir, ["step-01.png"], source, 10, outDir);
    expect(result).toEqual([]);
  });

  it("detects a changed step, writing before/after/diff PNGs with a non-zero change ratio", () => {
    const { repo } = makeBaselineRepo();
    const before = solidPng(4, 4, [0, 0, 0]);
    commitScreenshot(repo, "add-entry", "step-01.png", before);
    const source = gitBaselineSource(resolveBaselineLookup(join(repo, "public")), "HEAD");

    const after = solidPng(4, 4, [255, 255, 255]);
    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", after);
    const outDir = tmpDir();

    const result = diffAgainstBaseline("add-entry", newDir, ["step-01.png"], source, 10, outDir);
    expect(result).toHaveLength(1);
    const step = result![0];
    expect(step.step).toBe("step-01.png");
    expect(step.changeRatio).toBe(1);
    expect(step.before).toContain("before-step-01.png");
    expect(step.after).toContain("after-step-01.png");
    expect(step.diff).toContain("diff-step-01.png");
  });

  it("treats a step missing from the baseline as fully changed, not a new walkthrough", () => {
    const { repo } = makeBaselineRepo();
    commitScreenshot(repo, "add-entry", "step-01.png", solidPng(2, 2, [0, 0, 0]));
    const source = gitBaselineSource(resolveBaselineLookup(join(repo, "public")), "HEAD");

    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", solidPng(2, 2, [0, 0, 0]));
    writeNewScreenshot(newDir, "step-02.png", solidPng(2, 2, [9, 9, 9]));
    const outDir = tmpDir();

    const result = diffAgainstBaseline("add-entry", newDir, ["step-01.png", "step-02.png"], source, 10, outDir);
    expect(result).toHaveLength(1);
    expect(result![0].step).toBe("step-02.png");
    expect(result![0].before).toBe("");
    expect(result![0].changeRatio).toBe(1);
  });
});

describe("ci/diff diffAgainstBaseline (disk source, the default)", () => {
  function writeDiskBaseline(publicDir: string, walkthroughId: string, fileName: string, bytes: Buffer): void {
    const dir = join(publicDir, "screenshots", walkthroughId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), bytes);
  }

  it("returns undefined when there's no screenshots dir at all for the walkthrough on disk", () => {
    const publicDir = tmpDir();
    const source = diskBaselineSource(publicDir);
    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", solidPng(2, 2, [1, 2, 3]));
    const outDir = tmpDir();

    expect(diffAgainstBaseline("brand-new", newDir, ["step-01.png"], source, 10, outDir)).toBeUndefined();
  });

  it("detects a changed step straight off disk, with no git/repo involved", () => {
    const publicDir = tmpDir();
    const before = solidPng(4, 4, [0, 0, 0]);
    writeDiskBaseline(publicDir, "record-a-payment", "step-01.png", before);
    const source = diskBaselineSource(publicDir);

    const after = solidPng(4, 4, [255, 255, 255]);
    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", after);
    const outDir = tmpDir();

    const result = diffAgainstBaseline("record-a-payment", newDir, ["step-01.png"], source, 10, outDir);
    expect(result).toHaveLength(1);
    expect(result![0].changeRatio).toBe(1);
  });

  it("reports unchanged (noise floor) for a step within the frame-diff tolerance", () => {
    const publicDir = tmpDir();
    const before = solidPng(4, 4, [100, 100, 100]);
    writeDiskBaseline(publicDir, "record-a-payment", "step-01.png", before);
    const source = diskBaselineSource(publicDir);

    // 2 levels off on every channel — within a tolerance of 10, so this must not count as changed.
    const after = solidPng(4, 4, [102, 102, 102]);
    const newDir = tmpDir();
    writeNewScreenshot(newDir, "step-01.png", after);
    const outDir = tmpDir();

    const result = diffAgainstBaseline("record-a-payment", newDir, ["step-01.png"], source, 10, outDir);
    expect(result).toEqual([]);
  });
});
