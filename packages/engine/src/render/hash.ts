// Content-hash caching: skip a render if the output already exists with a matching .hash
// sidecar. The hash covers the timeline JSON, the render settings, and every frame/audio
// file the timeline references — identified by the sha256 of its bytes, not path+size+mtime,
// so a frame that's byte-identical to last run (e.g. frame-diff.ts's restored frames) never
// forces a re-render just because a filesystem touched its mtime.
//
// Hashing every referenced file's bytes on every run would mean re-reading hundreds of
// megabytes of JPEG/PNG frames each time, so the sha256 of each file is itself cached in a
// sidecar JSON, keyed by path+size+mtime: unchanged files are never re-read, only re-stat'd.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Timeline } from "./types.js";

export interface HashSettings {
  fps: number;
  crf: number;
  preset: string;
  draft: boolean;
}

interface FileHashCacheEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

/** Sidecar cache mapping a file path to its last-seen (size, mtime, sha256). Pass the same
 * instance across calls (e.g. loaded once per `render()` via `loadFileHashCache`/
 * `saveFileHashCache`) so repeated renders of the same walkthrough reuse hashes. */
export type FileHashCache = Record<string, FileHashCacheEntry>;

export function loadFileHashCache(file: string): FileHashCache {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as FileHashCache;
  } catch {
    return {};
  }
}

export function saveFileHashCache(file: string, cache: FileHashCache): void {
  writeFileSync(file, JSON.stringify(cache));
}

/** sha256 of `file`'s bytes, reusing `cache[file]` when its (size, mtimeMs) still match —
 * so an unchanged file is stat'd but never re-read. Missing files hash to a stable sentinel
 * so a deleted/renamed reference still changes the overall content hash. */
export function hashFileCached(file: string, cache: FileHashCache): string {
  if (!existsSync(file)) return `missing:${file}`;
  const st = statSync(file);
  const cached = cache[file];
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.hash;
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  cache[file] = { size: st.size, mtimeMs: st.mtimeMs, hash };
  return hash;
}

/** Computes a stable content hash for a timeline + the files it references + render settings.
 * `cache` (default: a fresh, call-scoped cache) speeds up repeated calls within/across a
 * process when the caller persists it — see `loadFileHashCache`/`saveFileHashCache`. */
export function computeContentHash(
  timeline: Timeline,
  resolvedFiles: string[],
  settings: HashSettings,
  cache: FileHashCache = {},
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(timeline));
  hash.update(JSON.stringify(settings));
  for (const f of [...resolvedFiles].sort()) hash.update(hashFileCached(f, cache));
  return hash.digest("hex");
}

export function hashSidecarPath(outputFile: string): string {
  return `${outputFile}.hash`;
}

/** True when `outputFile` exists and its sidecar matches `hash`. */
export function matchesCachedHash(outputFile: string, hash: string): boolean {
  if (!existsSync(outputFile)) return false;
  const sidecar = hashSidecarPath(outputFile);
  if (!existsSync(sidecar)) return false;
  try {
    return readFileSync(sidecar, "utf8").trim() === hash;
  } catch {
    return false;
  }
}

export function writeHashSidecar(outputFile: string, hash: string): void {
  writeFileSync(hashSidecarPath(outputFile), `${hash}\n`);
}
