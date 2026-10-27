// A bounded walk over an app repo for `aida domain` and `aida brief sources`: skips dependency,
// build and tool directories and never descends past `maxDepth`, so a large repo stays cheap.
import { readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".netlify",
  ".output",
  ".cache",
  ".vitest",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  "vendor",
  "graft",
  ".build",
]);

export interface WalkOptions {
  maxDepth?: number;
  /** Stop after this many matches. */
  limit?: number;
  /** Also skip directories starting with "." (default true; `.github` is always kept). */
  skipHidden?: boolean;
}

/** Repo-relative POSIX paths of files under `root` for which `match(rel)` is true. */
export function walkFiles(root: string, match: (rel: string) => boolean, opts: WalkOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 2000;
  const skipHidden = opts.skipHidden ?? true;
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (skipHidden && entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (depth < maxDepth) visit(full, depth + 1);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (match(rel)) out.push(rel);
      }
    }
  };
  visit(root, 0);
  return out;
}

/** Natural order ("9-x.sql" before "10-x.sql"), as migration tools apply files. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}
