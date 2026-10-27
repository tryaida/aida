// Plain-JS (no TypeScript, no tsx-only syntax) so it loads unmodified in a worker_thread spawned
// by plain `node` (frame-diff-worker.mjs) as well as from frame-diff.ts under tsx — see M11
// (docs/build-plan.md): decoding ~185 2880x1620 PNGs per capture rerun is the capture hot spot,
// and parallelising it via worker_threads needs an entry point plain `node` can load without the
// tsx ESM loader. This file is the single source of truth for the pixel-diff algorithm; frame-
// diff.ts's `diffPngBuffers` just re-exports it with types. Keep any edit here in sync with the
// (now-removed) duplicate that used to live in frame-diff.ts.
import { PNG } from "pngjs";

/**
 * Decodes two PNG buffers and compares them pixel-by-pixel with a per-channel tolerance.
 * Returns `{ changedFraction, dimensionsMatch }`. Never throws — unreadable/corrupt PNGs or a
 * dimension mismatch are reported as fully changed rather than crashing the build.
 */
export function diffPngBuffers(a, b, perChannelTolerance) {
  let pngA;
  let pngB;
  try {
    pngA = PNG.sync.read(a);
    pngB = PNG.sync.read(b);
  } catch {
    return { changedFraction: 1, dimensionsMatch: false };
  }

  if (pngA.width !== pngB.width || pngA.height !== pngB.height) {
    return { changedFraction: 1, dimensionsMatch: false };
  }

  const totalPixels = pngA.width * pngA.height;
  if (totalPixels === 0) return { changedFraction: 0, dimensionsMatch: true };

  const da = pngA.data;
  const db = pngB.data;
  let changedPixels = 0;
  for (let i = 0; i < da.length; i += 4) {
    const dr = Math.abs(da[i] - db[i]);
    const dg = Math.abs(da[i + 1] - db[i + 1]);
    const dbch = Math.abs(da[i + 2] - db[i + 2]);
    const dal = Math.abs(da[i + 3] - db[i + 3]);
    if (dr > perChannelTolerance || dg > perChannelTolerance || dbch > perChannelTolerance || dal > perChannelTolerance) {
      changedPixels++;
    }
  }

  return { changedFraction: changedPixels / totalPixels, dimensionsMatch: true };
}

/**
 * Cheap pre-check before any PNG decode: byte-identical buffers are always pixel-identical, so
 * this never changes a kept/changed decision — it only skips the (expensive) decode for frames
 * that happen to be exactly the same bytes.
 */
export function buffersEqual(a, b) {
  return a.length === b.length && a.equals(b);
}
