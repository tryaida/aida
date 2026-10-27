// `aida version list` (build-plan.md M21 step 1).
import { join } from "node:path";
import { readManifest } from "./manifest.js";
import type { VersionManifest } from "./types.js";

export function listVersions(helpApp: string): VersionManifest {
  const publicDir = join(helpApp, "public");
  return readManifest(publicDir) ?? { latest: "", versions: [] };
}
