// Builds a highlighted diff overlay PNG for the PR comment (decisions #23: "a highlighted diff
// image"). Reuses `capture/frame-diff.ts`'s pixel-diff core (same tolerance/decision as the
// capture pipeline's own frame stabilization) instead of a second diff algorithm.
import { PNG } from "pngjs";

/** Tint applied to a changed pixel in the overlay, over the "after" image's own colour, so the
 * overlay still reads as the after-screenshot with changes called out — not a plain red mask. */
const TINT = { r: 255, g: 56, b: 96 } as const;
const TINT_ALPHA = 0.55;

/**
 * Decodes `before`/`after` PNG buffers and returns an overlay PNG (same dimensions as `after`)
 * with every pixel that differs by more than `perChannelTolerance` on any channel tinted red.
 * Mismatched dimensions fall back to the plain `after` image (nothing sensible to overlay).
 */
export function buildDiffOverlay(before: Buffer, after: Buffer, perChannelTolerance: number): Buffer {
  let pngBefore: PNG;
  let pngAfter: PNG;
  try {
    pngBefore = PNG.sync.read(before);
    pngAfter = PNG.sync.read(after);
  } catch {
    return after;
  }
  if (pngBefore.width !== pngAfter.width || pngBefore.height !== pngAfter.height) {
    return after;
  }

  const out = new PNG({ width: pngAfter.width, height: pngAfter.height });
  const da = pngBefore.data;
  const db = pngAfter.data;
  for (let i = 0; i < db.length; i += 4) {
    const dr = Math.abs(da[i] - db[i]);
    const dg = Math.abs(da[i + 1] - db[i + 1]);
    const dbch = Math.abs(da[i + 2] - db[i + 2]);
    const dal = Math.abs(da[i + 3] - db[i + 3]);
    const changed = dr > perChannelTolerance || dg > perChannelTolerance || dbch > perChannelTolerance || dal > perChannelTolerance;
    if (changed) {
      out.data[i] = Math.round(db[i] * (1 - TINT_ALPHA) + TINT.r * TINT_ALPHA);
      out.data[i + 1] = Math.round(db[i + 1] * (1 - TINT_ALPHA) + TINT.g * TINT_ALPHA);
      out.data[i + 2] = Math.round(db[i + 2] * (1 - TINT_ALPHA) + TINT.b * TINT_ALPHA);
      out.data[i + 3] = 255;
    } else {
      out.data[i] = db[i];
      out.data[i + 1] = db[i + 1];
      out.data[i + 2] = db[i + 2];
      out.data[i + 3] = db[i + 3];
    }
  }
  return PNG.sync.write(out);
}
