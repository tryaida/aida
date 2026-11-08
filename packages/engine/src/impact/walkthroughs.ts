// Walkthrough + manifest discovery for `aida affected` (build-plan.md M17).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { CaptureManifest } from "../capture/types.js";
import { readPathCaptures } from "../capture/path-files.js";
import type { ResolvedConfig } from "../config/types.js";
import { primaryCaptureDir } from "../devices/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";

export interface WalkthroughEntry {
  id: string;
  /** Absolute path to the walkthrough YAML file. */
  file: string;
  /** Parsed from the primary device's `manifest.json` (`<buildDir>/<id>/capture/`, or `<id>/phone/capture/` for a phone-primary walkthrough), when a capture has run. */
  manifest: CaptureManifest | undefined;
  /** Each walkthrough path's last capture manifest (`capture/paths/<pathId>/`), when it has paths
   * that were captured (decision 34). A change on a screen only a path visits affects it too. */
  pathManifests?: { pathId: string; manifest: CaptureManifest }[];
}

/** Every `*.yaml`/`*.yml` walkthrough file directly under `walkthroughsDir`, with its id (the
 * `walkthrough:` field) and last-captured manifest, if any. Mirrors the scan in
 * commands/capture.ts's `findWalkthroughs`, minus the id/path-argument resolution that only
 * matters for `aida capture <ids...>`. */
export function listWalkthroughs(
  walkthroughsDir: string,
  buildDir: string,
  /** For each walkthrough's primary device (decision 40): its capture is read from that device's
   * dir. Without it, a walkthrough's own `devices` decides, else desktop. */
  config?: Pick<ResolvedConfig, "devices" | "configDir" | "brief">,
): WalkthroughEntry[] {
  if (!existsSync(walkthroughsDir)) return [];
  const brief = config ? loadBrief(briefPath(config)) : undefined;
  const files = readdirSync(walkthroughsDir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(walkthroughsDir, f))
    .sort();

  return files.map((file) => {
    const wt = loadWalkthroughFile(file);
    const captureDir = primaryCaptureDir({ buildDir, devices: config?.devices }, wt, brief);
    const manifestPath = join(captureDir, "manifest.json");
    let manifest: CaptureManifest | undefined;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureManifest;
      } catch {
        manifest = undefined;
      }
    }
    const pathManifests = readPathCaptures(captureDir, wt)
      .filter((p) => p.manifest)
      .map((p) => ({ pathId: p.pathId, manifest: p.manifest! }));
    return { id: wt.walkthrough, file, manifest, ...(pathManifests.length > 0 ? { pathManifests } : {}) };
  });
}
