// Locates the help app root (the directory `aida init` scaffolds as `<dir>/help`) from any
// file inside it, so edit actions that only take a walkthrough/page file path can still find
// `.aida/` for history, locks and the Studio's selection file. The marker is `next.config.mjs`
// (or `.ts`) — present at the help app root in every scaffolded project, regardless of package name.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MARKERS = ["next.config.mjs", "next.config.ts", "next.config.js"];

/** Walks up from `startPath` (a file or directory) to find the help app root. Throws if none is found. */
export function findHelpRoot(startPath: string): string {
  let dir = resolve(startPath);
  // startPath may be a file; start the walk from its directory either way (dirname of a dir is its parent, which is fine — the loop below checks dir itself first).
  if (existsSync(dir) && !isDir(dir)) dir = dirname(dir);

  for (;;) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find the help app root (no next.config.*) above ${resolve(startPath)}`);
    }
    dir = parent;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `<helpRoot>/.aida` — created on first use. */
export function aidaDir(helpRoot: string): string {
  const dir = join(helpRoot, ".aida");
  mkdirSync(dir, { recursive: true });
  return dir;
}
