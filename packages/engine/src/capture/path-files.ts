// The file side of walkthrough paths (decision 34), kept free of the browser runner so pages,
// procedures, outline drift and `aida affected` can read path captures without loading Playwright:
// where a path's capture lives, reading it back, and the write keys capture compares.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Walkthrough } from "../walkthrough/index.js";
import type { CaptureManifest, ImpactRequest, PathDiff, ValidationResult } from "./types.js";

/** `<captureDir>/paths/<pathId>`: one path's manifest, frames and validation. */
export function pathCaptureDir(captureDir: string, pathId: string): string {
  return join(captureDir, "paths", pathId);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for a path segment that names one record rather than a kind of thing: a number, a UUID,
 * a long hex string, or a long id with a digit in it (cuid, nanoid, a slug with a number). */
function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{12,}$/i.test(segment)) return true;
  return /^[A-Za-z0-9_-]{16,}$/.test(segment) && /\d/.test(segment);
}

/** A request path as a route pattern: record ids as `:id`, fragment dropped, and the query
 * reduced to its parameter names, sorted (`?mode=split&id=7` -> `?id&mode`): a different
 * parameter can mean a different save, a different value usually doesn't. */
export function routePattern(path: string): string {
  const [beforeHash] = path.split("#");
  const [pathname, query] = [beforeHash!.split("?")[0]!, beforeHash!.split("?").slice(1).join("?")];
  const pattern = pathname
    .split("/")
    .map((s) => {
      let decoded = s;
      try {
        decoded = decodeURIComponent(s);
      } catch {
        // keep as written
      }
      return s && isIdSegment(decoded) ? ":id" : s;
    })
    .join("/");
  const names = query ? [...new Set([...new URLSearchParams(query).keys()])].sort() : [];
  return names.length > 0 ? `${pattern}?${names.join("&")}` : pattern;
}

/** What a request saved, as a comparable key — `POST /api/payments/:id`, or `POST action <id>`
 * for a server action — or undefined for a read. */
export function writeKey(request: ImpactRequest): string | undefined {
  const method = request.method.toUpperCase();
  if (READ_METHODS.has(method)) return undefined;
  if (request.action) return `${method} action ${request.action}`;
  return `${method} ${routePattern(request.path)}`;
}

/** Every write a capture made, as keys, sorted, one entry per request (a save made twice is
 * listed twice). Steps from `fromStep` (0-based) on. */
export function writeKeys(manifest: Pick<CaptureManifest, "steps">, fromStep = 0): string[] {
  const keys: string[] = [];
  for (const step of manifest.steps.slice(fromStep)) {
    for (const r of step.impact?.requests ?? []) {
      const key = writeKey(r);
      if (key) keys.push(key);
    }
  }
  return keys.sort();
}

function counts(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** `POST /api/x`, or `POST /api/x ×2` for a save made more than once. */
function counted(key: string, n: number): string {
  return n > 1 ? `${key} ×${n}` : key;
}

/** The difference between a path's writes and the main run's, compared per key with counts (a
 * path saving the same thing twice differs), or undefined when they match. */
export function comparePathWrites(pathId: string, main: string[], path: string[]): PathDiff | undefined {
  const mainCounts = counts(main);
  const pathCounts = counts(path);
  const onlyInPath: string[] = [];
  const onlyInMain: string[] = [];
  for (const key of [...new Set([...mainCounts.keys(), ...pathCounts.keys()])].sort()) {
    const m = mainCounts.get(key) ?? 0;
    const p = pathCounts.get(key) ?? 0;
    if (m === p) continue;
    if (p > 0) onlyInPath.push(counted(key, p));
    if (m > 0) onlyInMain.push(counted(key, m));
  }
  if (onlyInPath.length === 0 && onlyInMain.length === 0) return undefined;
  const list = (keys: string[]) => (keys.length > 0 ? keys.join(", ") : "no save");
  return {
    path: pathId,
    main,
    pathWrites: path,
    onlyInPath,
    onlyInMain,
    message: `path ${pathId} saves differently: ${list(onlyInPath)} vs ${list(onlyInMain)}`,
  };
}

/** Distinct frame images a manifest references. */
export function countFrames(manifest: Pick<CaptureManifest, "steps">): number {
  const names = new Set<string>();
  for (const step of manifest.steps) {
    for (const e of step.events) {
      if (e.type === "frame") names.add(e.image);
      if (e.type === "scrollFrames" || e.type === "typeFrames") {
        for (const img of e.images) names.add(img);
      }
    }
  }
  return names.size;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** One path's latest capture on disk. */
export interface PathCapture {
  pathId: string;
  dir: string;
  manifest?: CaptureManifest;
  validation?: ValidationResult;
}

/** Every path's latest capture under `captureDir` (missing files left undefined). */
export function readPathCaptures(captureDir: string, walkthrough: Pick<Walkthrough, "paths">): PathCapture[] {
  return (walkthrough.paths ?? []).map((p) => {
    const dir = pathCaptureDir(captureDir, p.id);
    return {
      pathId: p.id,
      dir,
      manifest: readJson<CaptureManifest>(join(dir, "manifest.json")),
      validation: readJson<ValidationResult>(join(dir, "validation.json")),
    };
  });
}

