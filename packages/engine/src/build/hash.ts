// Content hashing for the build pipeline's "only rebuild what changed" skip logic
// (docs/scope.md "Only rebuild what changed"). Capture already writes a deterministic
// manifest.json (no volatile fields — see capture/types.ts CaptureManifest doc). Render and
// voice have their own internal content-hash caches (render/hash.ts, voice/cache.ts) and report
// their own skip state; this module is for the one stage that doesn't: pages.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic stringify: sorts object keys so field order never changes the hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Next.js's React Server Components fetch appends a short random `_rsc=<token>` cache-busting
// query param to every RSC navigation request — observed in the wild against a real pilot
// app's impact-tracked request paths (`capture/types.ts` `StepImpact.requests[].path`). It isn't
// a UUID, so `stableHash()`'s UUID normalisation doesn't catch it, and it changes on every real
// capture even when nothing a reader would notice did — which would defeat the pages skip check
// below. Stripped here defensively, independent of whatever capture's own stableHash handles.
const RSC_TOKEN_RE = /([?&]_rsc=)[^&"]+/g;

function stripVolatileQueryParams(value: unknown): unknown {
  if (typeof value === "string") return value.replace(RSC_TOKEN_RE, "$1<rsc>");
  if (Array.isArray(value)) return value.map(stripVolatileQueryParams);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripVolatileQueryParams(v);
    return out;
  }
  return value;
}

/**
 * Hashes a capture manifest for skip decisions. Prefers `captureModule.stableHash` (a
 * volatile-id-free hash the capture/pages builder is adding in a parallel milestone) when it's
 * been exported; until then, falls back to hashing the manifest with its one known-volatile
 * field (`capturedAt`, deprecated — see capture/types.ts) stripped. Either way, strips Next.js's
 * `_rsc` cache-busting tokens first (see `RSC_TOKEN_RE` above) — `stableHash` only normalises
 * UUIDs, not those.
 */
export function manifestHash(manifest: unknown, captureModule?: Record<string, unknown>): string {
  const clone = JSON.parse(JSON.stringify(manifest));
  const sanitized = stripVolatileQueryParams(clone);
  const fn = captureModule?.stableHash;
  if (typeof fn === "function") return fn(sanitized) as string;
  delete (sanitized as Record<string, unknown>).capturedAt;
  return sha256(stableStringify(sanitized));
}

/** Reads a small JSON hash-cache file, tolerating a missing/corrupt file (returns `{}`). */
export function readHashCache(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeHashCache(file: string, cache: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}
