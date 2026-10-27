import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBaselineLookup, getBaselineScreenshot, listBaselineWalkthroughIds } from "../../src/ci/baseline.js";
import { cleanupTmpDirs, commitScreenshot, makeBaselineRepo, solidPng } from "./helpers.js";

afterEach(cleanupTmpDirs);

describe("ci/baseline", () => {
  it("resolves the repo root and finds a committed screenshot by ref", () => {
    const { repo, baseSha } = makeBaselineRepo();
    const bytes = solidPng(2, 2, [10, 20, 30]);
    commitScreenshot(repo, "add-entry", "step-01.png", bytes);

    const publicDir = join(repo, "public");
    const lookup = resolveBaselineLookup(publicDir);
    expect(lookup.repoRoot).toBe(repo);
    expect(lookup.screenshotsRelDir).toBe("public/screenshots");

    const found = getBaselineScreenshot(lookup, "HEAD", "add-entry", "step-01.png");
    expect(found).toEqual(bytes);

    // Not present at the pre-screenshot commit.
    const notFound = getBaselineScreenshot(lookup, baseSha, "add-entry", "step-01.png");
    expect(notFound).toBeUndefined();
  });

  it("lists baseline walkthrough ids at a ref", () => {
    const { repo, baseSha } = makeBaselineRepo();
    commitScreenshot(repo, "add-entry", "step-01.png", solidPng(2, 2, [1, 1, 1]));
    commitScreenshot(repo, "record-payment", "step-01.png", solidPng(2, 2, [2, 2, 2]));

    const lookup = resolveBaselineLookup(join(repo, "public"));
    expect(listBaselineWalkthroughIds(lookup, "HEAD").sort()).toEqual(["add-entry", "record-payment"]);
    expect(listBaselineWalkthroughIds(lookup, baseSha)).toEqual([]);
  });
});
