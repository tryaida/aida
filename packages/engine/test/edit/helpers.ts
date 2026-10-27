import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/engine/test/edit -> repo root
export const REPO_ROOT = join(here, "..", "..", "..", "..");

const createdTmpDirs: string[] = [];

export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aida-edit-test-"));
  createdTmpDirs.push(dir);
  return dir;
}

/** Removes every tmp dir created via tmpDir()/setupHelpApp() so far. Call from an afterEach in
 * each test file that uses these helpers. */
export function cleanupTmpDirs(): void {
  while (createdTmpDirs.length > 0) {
    const dir = createdTmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake help app dir (just enough for findHelpRoot: a next.config.mjs marker) with a copy of
 * the "add-competitor-and-entry" fixture walkthrough. */
export function setupHelpApp(): { helpRoot: string; walkthroughFile: string } {
  const helpRoot = tmpDir();
  writeFileSync(join(helpRoot, "next.config.mjs"), "export default {};\n");
  mkdirSync(join(helpRoot, "walkthroughs"), { recursive: true });
  const src = join(REPO_ROOT, "packages", "engine", "test", "fixtures", "walkthroughs", "add-competitor-and-entry.yaml");
  const dest = join(helpRoot, "walkthroughs", "add-competitor-and-entry.yaml");
  copyFileSync(src, dest);
  return { helpRoot, walkthroughFile: dest };
}
