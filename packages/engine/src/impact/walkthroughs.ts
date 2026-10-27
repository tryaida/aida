// Walkthrough + manifest discovery for `aida affected` (build-plan.md M17).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { CaptureManifest } from "../capture/types.js";

export interface WalkthroughEntry {
  id: string;
  /** Absolute path to the walkthrough YAML file. */
  file: string;
  /** Parsed from `<buildDir>/<id>/capture/manifest.json`, when a capture has run. */
  manifest: CaptureManifest | undefined;
}

/** Every `*.yaml`/`*.yml` walkthrough file directly under `walkthroughsDir`, with its id (the
 * `walkthrough:` field) and last-captured manifest, if any. Mirrors the scan in
 * commands/capture.ts's `findWalkthroughs`, minus the id/path-argument resolution that only
 * matters for `aida capture <ids...>`. */
export function listWalkthroughs(walkthroughsDir: string, buildDir: string): WalkthroughEntry[] {
  if (!existsSync(walkthroughsDir)) return [];
  const files = readdirSync(walkthroughsDir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(walkthroughsDir, f))
    .sort();

  return files.map((file) => {
    const wt = loadWalkthroughFile(file);
    const manifestPath = join(buildDir, wt.walkthrough, "capture", "manifest.json");
    let manifest: CaptureManifest | undefined;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureManifest;
      } catch {
        manifest = undefined;
      }
    }
    return { id: wt.walkthrough, file, manifest };
  });
}
