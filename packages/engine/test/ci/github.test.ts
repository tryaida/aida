import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushPreviewImages, upsertPrComment, createGithubFakeFetch, resolveOwnerRepo } from "../../src/ci/github.js";
import { createFakeCommandRunner } from "../../src/ci/runner.js";
import type { CiResult } from "../../src/ci/types.js";
import { cleanupTmpDirs, tmpDir } from "./helpers.js";

afterEach(cleanupTmpDirs);

function makeResult(outDir: string): CiResult {
  const dir = join(outDir, "add-entry");
  mkdirSync(dir, { recursive: true });
  const before = join(dir, "before-step-01.png");
  const after = join(dir, "after-step-01.png");
  const diff = join(dir, "diff-step-01.png");
  writeFileSync(before, "before-bytes");
  writeFileSync(after, "after-bytes");
  writeFileSync(diff, "diff-bytes");
  return {
    base: "base-sha",
    head: "head-sha",
    affected: ["add-entry"],
    all: false,
    results: [{ walkthrough: "add-entry", status: "changed", changedSteps: [{ step: "step-01.png", before, after, diff, changeRatio: 0.1 }] }],
    stalePages: [],
    outDir,
  };
}

describe("ci/github pushPreviewImages", () => {
  it("clones the existing previews branch, commits under pr-<n>/<headSha>/, and pushes with the authed url", async () => {
    const outDir = tmpDir();
    const result = makeResult(outDir);
    const { runner, calls } = createFakeCommandRunner((cmd, args) => {
      if (args[0] === "clone") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "deadbeef\n", stderr: "" };
    });

    const pushed = await pushPreviewImages(result, {
      ownerRepo: { owner: "acme", repo: "app" },
      token: "ghs_test",
      prNumber: 7,
      runner,
      cloneUrl: "https://github.com/acme/app.git",
    });

    expect(pushed.prefix).toBe("pr-7/head-sha");
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall?.args).toContain("aida-previews");
    expect(cloneCall?.args.some((a) => a.includes("x-access-token:ghs_test@"))).toBe(true);

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args[1]).toContain("x-access-token:ghs_test@");
    expect(pushCall?.args[2]).toBe("HEAD:aida-previews");

    const commitCall = calls.find((c) => c.args.includes("commit") && c.args.some((a) => a.includes("PR #7")));
    expect(commitCall).toBeTruthy();
  });

  it("creates the orphan branch when the clone fails (branch doesn't exist yet)", async () => {
    const outDir = tmpDir();
    const result = makeResult(outDir);
    const { runner, calls } = createFakeCommandRunner((cmd, args) => {
      if (args[0] === "clone") return { code: 1, stdout: "", stderr: "branch not found" };
      return { code: 0, stdout: "deadbeef\n", stderr: "" };
    });

    await pushPreviewImages(result, { ownerRepo: { owner: "acme", repo: "app" }, token: "t", prNumber: 1, runner, cloneUrl: "https://github.com/acme/app.git" });

    expect(calls.some((c) => c.args[0] === "init")).toBe(true);
    expect(calls.some((c) => c.args[0] === "checkout" && c.args.includes("--orphan"))).toBe(true);
  });
});

describe("ci/github upsertPrComment", () => {
  it("creates a new comment when none has the marker yet", async () => {
    const { fetchImpl, comments } = createGithubFakeFetch([]);
    const result = await upsertPrComment({ owner: "acme", repo: "app" }, 9, "<!-- aida-ci-comment -->\nhello", "tok", fetchImpl);
    expect(result.action).toBe("created");
    expect(comments).toHaveLength(1);
  });

  it("finds the marked comment and PATCHes it instead of creating a second one", async () => {
    const { fetchImpl, comments } = createGithubFakeFetch([
      { id: 1, body: "some other comment" },
      { id: 2, body: "<!-- aida-ci-comment -->\nold body" },
    ]);
    const result = await upsertPrComment({ owner: "acme", repo: "app" }, 9, "<!-- aida-ci-comment -->\nnew body", "tok", fetchImpl);
    expect(result.action).toBe("updated");
    expect(result.id).toBe(2);
    expect(comments).toHaveLength(2);
    expect(comments.find((c) => c.id === 2)?.body).toContain("new body");
  });
});

describe("ci/github resolveOwnerRepo", () => {
  it("prefers GITHUB_REPOSITORY over the git remote", () => {
    const result = resolveOwnerRepo(process.cwd(), { GITHUB_REPOSITORY: "acme/storefront" });
    expect(result).toEqual({ owner: "acme", repo: "storefront" });
  });
});
