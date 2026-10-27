import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

const createdDirs: string[] = [];

export function tmpDir(prefix = "aida-ci-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

/** A solid-colour PNG, for fixture screenshots. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A throwaway git repo with `public/screenshots/<id>/<fileName>` committed at a "base" commit,
 * for `ci/baseline.ts` + `ci/diff.ts` tests — no Playwright/capture involved.
 */
export function makeBaselineRepo(): { repo: string; baseSha: string } {
  const repo = tmpDir("aida-ci-baseline-repo-");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  writeFileSync(join(repo, "README.md"), "fixture repo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return { repo, baseSha };
}

export function commitScreenshot(repo: string, walkthroughId: string, fileName: string, bytes: Buffer): string {
  const dir = join(repo, "public", "screenshots", walkthroughId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), bytes);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `screenshot ${walkthroughId}/${fileName}`]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}
