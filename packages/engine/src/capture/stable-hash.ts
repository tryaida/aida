// Manifest stability: the real app assigns a fresh UUID to every competitor/entry it creates, so
// two otherwise-identical captures of the same walkthrough against the same app state produce a
// `manifest.json` that differs byte-for-byte wherever one of those ids shows up — a step's
// `impact.urls`/`requests` (e.g. `/dashboard/entries/success/<uuid>`), `finalUrl`, or a database
// check's returned row. A cache keyed on the raw manifest (or anything hashed straight from it)
// would then always miss, even when nothing a reader would notice changed.
//
// `stableHash()` normalises every UUID it finds — in any string, anywhere in the manifest — to a
// fixed placeholder before hashing, so the hash is stable across runs. Any code that hashes
// capture output for caching (page rebuild skip, render content-hash, CI change detection, etc.)
// should hash through this rather than hashing `manifest` (or a structure derived from it) raw.
//
// NOTE for whoever wires `src/build/**`/`src/digest/**`: `packages/engine/src/render/hash.ts`'s
// `computeContentHash()` hashes a `Timeline` (derived from the manifest, not the manifest itself)
// plus file fingerprints, so it isn't directly exposed to this — but if any cache check ends up
// hashing `manifest.json`'s bytes/content directly (e.g. to decide whether to skip a recapture or
// a page rebuild), route it through `stableHash()` here instead of `JSON.stringify(manifest)`.
import { createHash } from "node:crypto";
import type { CaptureManifest } from "./types.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_PLACEHOLDER = "<uuid>";

function normalise(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UUID_RE, UUID_PLACEHOLDER);
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalise(v);
    return out;
  }
  return value;
}

/**
 * Computes a content hash for a capture manifest with volatile, app-generated UUIDs normalised
 * out first (see module doc above). Deterministic across runs that only differ in which ids the
 * app happened to assign.
 */
export function stableHash(manifest: CaptureManifest): string {
  return createHash("sha256").update(JSON.stringify(normalise(manifest))).digest("hex");
}
