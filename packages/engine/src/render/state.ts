// Pure state-math port of assets/player/player.js's renderAt(t) lookups (lastAtOrBefore,
// cameraAt, cursorAt, and the highlight/caption/chip "active at t" finds). player.js's header
// comment says it best: "every visual is a pure function of time" — renderAt(t) reads nothing
// but `window.TIMELINE` and `t`. segments.ts needs exactly that same function of time, evaluated
// at a scene's t0, to know what state an earlier scene hands into this one (the frame still on
// screen, the cursor/camera mid-move, an open highlight) without spinning up a browser. Keep
// this in sync with player.js's `lastAtOrBefore`/`cameraAt`/`cursorAt`/highlight-find by hand —
// same pattern as timeline.ts's header note that it's a hand-kept port of compose.mjs.
import type {
  CameraFrame,
  Point,
  Timeline,
  TimelineBlurWindow,
  TimelineCalloutWindow,
  TimelineCaption,
  TimelineChip,
  TimelineFrameCue,
  TimelineHighlight,
  TimelineReveal,
} from "./types.js";

function lastAtOrBefore<T>(list: T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (key(list[m]) <= t) {
      ans = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return ans;
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const ease = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);
const ramp = (t: number, t0: number, d: number): number => clamp((t - t0) / d, 0, 1);

/** The frame cue on screen at `t` — mirrors player.js's `lastAtOrBefore(TL.frames, t)` fallback
 * to index 0 when `t` is before the first cue (there's always at least one frame cue). */
export function frameAt(tl: Timeline, t: number): TimelineFrameCue {
  const fi = Math.max(0, lastAtOrBefore(tl.frames, t, (f) => f.t));
  return tl.frames[fi];
}

/** Mirrors player.js's `cameraAt`. */
export function cameraAt(tl: Timeline, t: number): CameraFrame {
  const i = lastAtOrBefore(tl.cameras, t, (c) => c.t0);
  if (i < 0) return tl.cameras[0].from;
  const c = tl.cameras[i];
  const p = ease(ramp(t, c.t0, c.t1 - c.t0));
  return { z: lerp(c.from.z, c.to.z, p), cx: lerp(c.from.cx, c.to.cx, p), cy: lerp(c.from.cy, c.to.cy, p) };
}

/** Mirrors player.js's `cursorAt` (including the sideways "arc" bend). */
export function cursorAt(tl: Timeline, t: number): Point {
  const i = lastAtOrBefore(tl.moves, t, (m) => m.t0);
  if (i < 0) return { ...tl.cursorStart };
  const m = tl.moves[i];
  const p = ease(ramp(t, m.t0, m.t1 - m.t0));
  const dx = m.to.x - m.from.x;
  const dy = m.to.y - m.from.y;
  const bend = Math.sin(Math.PI * p) * 0.08;
  return { x: lerp(m.from.x, m.to.x, p) - dy * bend, y: lerp(m.from.y, m.to.y, p) + dx * bend };
}

/** Mirrors player.js's highlight find: `TL.highlights.find((h) => t >= h.t0 && t <= h.t1)`. */
export function highlightAt(tl: Timeline, t: number): TimelineHighlight | undefined {
  return tl.highlights.find((h) => t >= h.t0 && t <= h.t1);
}

/** M22: the active callout window at `t` (a step's whole on-screen window, not an animated
 * ramp like `highlightAt`) — mirrors player.js's `calloutsAt`. */
export function calloutsAt(tl: Timeline, t: number): TimelineCalloutWindow | undefined {
  return (tl.callouts ?? []).find((w) => t >= w.t0 && t <= w.t1);
}

/** M22: the active blur window at `t` — mirrors player.js's `blurAt`. */
export function blurAt(tl: Timeline, t: number): TimelineBlurWindow | undefined {
  return (tl.blur ?? []).find((w) => t >= w.t0 && t <= w.t1);
}

/** Mirrors player.js's caption find. */
export function captionAt(tl: Timeline, t: number): TimelineCaption | undefined {
  return tl.captions.find((c) => t >= c.t0 && t <= c.t1);
}

/** Mirrors player.js's chip find. */
export function chipAt(tl: Timeline, t: number): TimelineChip | undefined {
  return tl.chips.find((c) => t >= c.t0 && t < c.t1);
}

/** The title cards' reveal schedule: the timeline's own (M34), else the original fixed one —
 * mirrors player.js's `CARDS` fallback. */
export function cardRevealsOf(tl: Timeline): { intro: TimelineReveal[]; outro: TimelineReveal[] } {
  if (tl.cards) return tl.cards;
  const o0 = tl.stageOut.t0 + 0.35;
  const n = tl.outro.recap.length;
  return {
    intro: [
      { id: "intro-brand", t0: 0.15, d: 0.7, dy: 26 },
      { id: "intro-eyebrow", t0: 0.45, d: 0.7, dy: 26 },
      { id: "intro-title", t0: 0.65, d: 0.8, dy: 40 },
      { id: "intro-sub", t0: 1.15, d: 0.7, dy: 26 },
      { id: "intro-facts", t0: 1.6, d: 0.7, dy: 26 },
    ],
    outro: [
      { id: "outro-title", t0: o0, d: 0.7, dy: 40 },
      ...Array.from({ length: n }, (_, i) => ({ id: `recap-${i}`, t0: o0 + 0.5 + i * 0.35, d: 0.6, dy: 18 })),
      { id: "outro-foot", t0: o0 + 0.6 + n * 0.35, d: 0.7, dy: 26 },
    ],
  };
}

/** Everything `renderAt(t0)` depends on that isn't already in the scene's own sliced cues —
 * i.e. state carried in from earlier timeline activity: the frame still visible from a previous
 * step, a cursor/camera move that started earlier and is still animating in, or a highlight
 * opened by a previous step and not yet closed. `sliceTimelineForScene` includes this in each
 * scene's hash so the hash covers exactly what the player reads when it enters the scene. */
export interface SceneEntryState {
  frame: { src: string; transition: string };
  camera: CameraFrame;
  cursor: Point;
  highlight: { t0: number; t1: number; box: TimelineHighlight["box"] } | null;
  caption: string | null;
  chip: string | null;
}

/**
 * A full visual signature of frame `t` — every value `renderAt(t)` (assets/player/player.js)
 * computes to set DOM style/content, flattened and stringified. Two frames with an identical
 * signature are pixel-identical: `renderAt` reads nothing else, so there is nothing left that
 * could differ on screen. video.ts's `renderFrameRange` uses this (M16 part 2) to skip the
 * Chromium `page.evaluate`/`screenshot` round trip for a frame whose signature matches the
 * previous rendered frame's and just repeat that frame's screenshot bytes — most of a
 * walkthrough is a still screenshot with a caption while narration plays; motion (cursor moves,
 * highlights animating in, camera/transitions) is confined to short windows this signature makes
 * exact.
 *
 * Must be kept in sync with player.js's `renderAt` by hand (same pattern as this file's header
 * note for the rest of its exports) — every `ramp()`/`ease()` term player.js feeds into a style
 * or text value has a matching term here, in the same order player.js computes it, so that
 * outside any active animation window (where `ramp` has saturated to its clamped 0/1 endpoint)
 * two different `t` values produce byte-identical JSON.
 */
export function frameSignature(tl: Timeline, t: number): string {
  const parts: Array<number | string> = [];
  const push = (...vals: Array<number | string>) => {
    parts.push(...vals);
  };

  // Stage envelope (intro card -> stage -> outro card).
  const sIn = ease(ramp(t, tl.stageIn.t0, tl.stageIn.t1 - tl.stageIn.t0));
  const sOut = ease(ramp(t, tl.stageOut.t0, tl.stageOut.t1 - tl.stageOut.t0));
  const stageVis = sIn * (1 - sOut);
  push(stageVis, sIn, sOut);

  // Intro and outro cards: every element's reveal progress (player.js styles each from its raw
  // ramp alone, whatever the preset's easing).
  const cards = cardRevealsOf(tl);
  const iOut = ease(ramp(t, tl.stageIn.t0 - 0.45, 0.5));
  push(iOut);
  for (const r of cards.intro) push(ramp(t, r.t0, r.d));
  const oIn = ease(ramp(t, tl.stageOut.t0 + 0.25, 0.7));
  push(oIn);
  for (const r of cards.outro) push(ramp(t, r.t0, r.d));

  if (stageVis > 0.001) {
    const fi = Math.max(0, lastAtOrBefore(tl.frames, t, (f) => f.t));
    const cur = tl.frames[fi];
    const prev = tl.frames[Math.max(0, fi - 1)];
    const fadeP = cur.transition === "fade" ? ramp(t, cur.t, tl.fade) : 1;
    push(prev.src, cur.src, fadeP);

    const VW = tl.viewport.w;
    const VH = tl.viewport.h;
    const c = cameraAt(tl, t);
    const z = c.z;
    const cx = clamp(c.cx, VW / 2 / z, VW - VW / 2 / z);
    const cy = clamp(c.cy, VH / 2 / z, VH - VH / 2 / z);
    push(z, cx, cy);

    const hi = highlightAt(tl, t);
    if (hi) {
      const a = Math.min(easeOut(ramp(t, hi.t0, 0.3)), 1 - ramp(t, hi.t1 - 0.25, 0.25));
      push(hi.box.x, hi.box.y, hi.box.w, hi.box.h, a, hi.num ?? "");
    } else push("none");

    // M22: callouts/blur are static for a step's whole window (no ramp/animation), so their
    // signature term is just every value that ends up on screen for them.
    const co = calloutsAt(tl, t);
    if (co) {
      for (const item of co.items) push(item.box.x, item.box.y, item.box.w, item.box.h, item.num, item.label ?? "");
    } else push("nocallouts");
    const bl = blurAt(tl, t);
    if (bl) {
      for (const box of bl.boxes) push(box.x, box.y, box.w, box.h);
    } else push("noblur");

    const p = cursorAt(tl, t);
    const press = tl.clicks.some((k) => t >= k.t && t <= k.t + 0.16) ? 0.86 : 1;
    const cVis = ramp(t, tl.stageIn.t1 - 0.2, 0.4);
    push(p.x, p.y, press, cVis);

    for (const k of tl.clicks) {
      const q = (t - k.t) / 0.55;
      if (q < 0 || q > 1) push("h");
      else push(k.x, k.y, easeOut(q), 1 - q);
    }
  }

  const cap = captionAt(tl, t);
  push(cap ? cap.text : "", cap ? Math.min(ramp(t, cap.t0, 0.2), 1 - ramp(t, cap.t1 - 0.2, 0.2)) : 0);

  const chip = chipAt(tl, t);
  push(chip ? chip.num : "", chip ? chip.eyebrow : "", chip ? chip.title : "", chip ? easeOut(ramp(t, chip.t0, 0.35)) : 0);

  return JSON.stringify(parts);
}

export function stateAt(tl: Timeline, t: number): SceneEntryState {
  const f = frameAt(tl, t);
  const hi = highlightAt(tl, t);
  const cap = captionAt(tl, t);
  const chip = chipAt(tl, t);
  return {
    frame: { src: f.src, transition: f.transition },
    camera: cameraAt(tl, t),
    cursor: cursorAt(tl, t),
    highlight: hi ? { t0: hi.t0, t1: hi.t1, box: hi.box } : null,
    caption: cap?.text ?? null,
    chip: chip ? `${chip.num}|${chip.eyebrow}|${chip.title}` : null,
  };
}
