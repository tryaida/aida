import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChangedFiles } from "../../src/impact/git.js";

const createdDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-impact-git-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initRepo(): string {
  const dir = tmpDir();
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

describe("getChangedFiles", () => {
  it("lists files changed between a base ref and HEAD", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["tag", "base"]);

    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "page.tsx"), "x");
    writeFileSync(join(repo, "a.txt"), "2");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "second"]);

    const files = getChangedFiles(repo, "base");
    expect(files.sort()).toEqual(["a.txt", "app/page.tsx"]);
  });

  it("includes working-tree changes (staged, unstaged, untracked) when requested", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["tag", "base"]);

    writeFileSync(join(repo, "a.txt"), "2"); // unstaged
    writeFileSync(join(repo, "untracked.txt"), "new"); // untracked

    expect(getChangedFiles(repo, "base")).toEqual([]);
    const withWorkingTree = getChangedFiles(repo, "base", "HEAD", { includeWorkingTree: true });
    expect(withWorkingTree.sort()).toEqual(["a.txt", "untracked.txt"]);
  });

  it("evaluates one historic commit in isolation when a head ref is given", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["tag", "c1"]);

    writeFileSync(join(repo, "b.txt"), "2");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "second"]);
    git(repo, ["tag", "c2"]);

    writeFileSync(join(repo, "c.txt"), "3"); // a later commit after c2 — must not leak into the c1..c2 diff
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "third"]);

    expect(getChangedFiles(repo, "c1", "c2")).toEqual(["b.txt"]);
  });

  it("throws a clear error for a bad base ref", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    expect(() => getChangedFiles(repo, "not-a-real-ref")).toThrow(/git diff/);
  });
});
