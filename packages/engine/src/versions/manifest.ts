// Reads/writes `public/versions.json` (see types.ts `VersionManifest`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VersionManifest } from "./types.js";

export function manifestPath(publicDir: string): string {
  return join(publicDir, "versions.json");
}

export function readManifest(publicDir: string): VersionManifest | undefined {
  const file = manifestPath(publicDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as VersionManifest).versions)) {
      return parsed as VersionManifest;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeManifest(publicDir: string, manifest: VersionManifest): void {
  mkdirSync(dirname(manifestPath(publicDir)), { recursive: true });
  writeFileSync(manifestPath(publicDir), JSON.stringify(manifest, null, 2), "utf8");
}
