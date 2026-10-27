// How much of the screen changed between two capture frames (M36), so the timeline can cut —
// rather than crossfade — when a menu or dropdown opens or closes in place. Frames are read as
// grey levels at one pixel per CSS px (pages/focus.ts's `grayFrame`) and compared on a sparse
// grid: this is a cheap "small change or new screen?" test, not a pixel-exact diff.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { grayFrame, type GrayFrame } from "../pages/focus.js";

/** Grey-level step that counts as a changed pixel. */
const STEP = 24;

/** Share of pixels (sampled every `stride` px) that differ between two same-size frames. */
export function changedShare(a: GrayFrame, b: GrayFrame, stride = 2): number | undefined {
  if (a.width !== b.width || a.height !== b.height) return undefined;
  let changed = 0, total = 0;
  for (let y = 0; y < a.height; y += stride) {
    for (let x = 0; x < a.width; x += stride) {
      const i = y * a.width + x;
      total++;
      if (Math.abs(a.lum[i] - b.lum[i]) > STEP) changed++;
    }
  }
  return total > 0 ? changed / total : undefined;
}

/** `frameChange` for `buildTimeline`: reads frames from `<captureDir>/frames/`, keeping the
 * last few decoded. Undefined for a frame that can't be read (the transition stays as captured). */
export function frameChangeReader(captureDir: string, deviceScaleFactor: number | undefined): (from: string, to: string) => number | undefined {
  const cache = new Map<string, GrayFrame | undefined>();
  const read = (frame: string): GrayFrame | undefined => {
    if (cache.has(frame)) return cache.get(frame);
    let out: GrayFrame | undefined;
    try {
      const png = PNG.sync.read(readFileSync(path.join(captureDir, "frames", frame)));
      out = grayFrame(png.data, png.width, png.height, Math.max(deviceScaleFactor ?? 1, 1));
    } catch {
      out = undefined;
    }
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    cache.set(frame, out);
    return out;
  };
  return (from, to) => {
    const a = read(from);
    const b = a ? read(to) : undefined;
    return a && b ? changedShare(a, b) : undefined;
  };
}
