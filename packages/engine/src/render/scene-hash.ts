// One scene's content hash, apart from the renderer so light callers (the build's release-video
// check, reached from the help app's runtime) can recompute it without loading Playwright.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FileHashCache, HashSettings } from "./hash.js";
import { hashFileCached } from "./hash.js";
import { stateAt } from "./state.js";
import type {
  Timeline,
  TimelineAudioCue,
  TimelineBlurWindow,
  TimelineCalloutWindow,
  TimelineCamera,
  TimelineCaption,
  TimelineChip,
  TimelineClick,
  TimelineFrameCue,
  TimelineHighlight,
  TimelineMove,
  TimelineScene,
} from "./types.js";

function overlapsRange(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

function inScene(t: number, scene: TimelineScene): boolean {
  return t >= scene.t0 && t < scene.t1;
}

/** The subset of a `Timeline` that actually affects one scene's rendered pixels: that scene's
 * cues, plus the always-on global fields (fps/viewport/stage/fade/brand/intro/outro/chapters/
 * cursorStart/stageIn/stageOut) that every scene's frames are composited against regardless of
 * which step they belong to (e.g. the intro/outro stage transform overlaps into the first and
 * last step). Used only to compute this scene's hash — the actual render still uses the full
 * timeline (player.js's `renderAt(t)` is a pure function of absolute time against the whole
 * `window.TIMELINE`), so nothing about playback changes, only what's hashed. */
export function sliceTimelineForScene(tl: Timeline, scene: TimelineScene): Record<string, unknown> {
  const frames: TimelineFrameCue[] = tl.frames.filter((f) => inScene(f.t, scene));
  const moves: TimelineMove[] = tl.moves.filter((m) => overlapsRange(m.t0, m.t1, scene.t0, scene.t1));
  const clicks: TimelineClick[] = tl.clicks.filter((c) => inScene(c.t, scene));
  const highlights: TimelineHighlight[] = tl.highlights.filter((h) => overlapsRange(h.t0, h.t1, scene.t0, scene.t1));
  const cameras: TimelineCamera[] = tl.cameras.filter((c) => overlapsRange(c.t0, c.t1, scene.t0, scene.t1));
  const captions: TimelineCaption[] = tl.captions.filter((c) => overlapsRange(c.t0, c.t1, scene.t0, scene.t1));
  const chips: TimelineChip[] = tl.chips.filter((c) => overlapsRange(c.t0, c.t1, scene.t0, scene.t1));
  const audio: TimelineAudioCue[] = tl.audio.filter((a) => inScene(a.t, scene));
  const callouts: TimelineCalloutWindow[] = (tl.callouts ?? []).filter((w) => overlapsRange(w.t0, w.t1, scene.t0, scene.t1));
  const blur: TimelineBlurWindow[] = (tl.blur ?? []).filter((w) => overlapsRange(w.t0, w.t1, scene.t0, scene.t1));
  // State carried in from earlier scenes that player.js's renderAt(t0) still reads on entry
  // (e.g. the previous step's frame fading under the outro, or a cursor/camera move started in
  // an earlier scene and still animating into this one) — see state.ts's header comment.
  const entryState = stateAt(tl, scene.t0);
  return {
    scene,
    entryState,
    fps: tl.fps,
    viewport: tl.viewport,
    frame: tl.frame,
    stage: tl.stage,
    band: tl.band,
    pointer: tl.pointer,
    fade: tl.fade,
    brand: tl.brand,
    intro: tl.intro,
    outro: tl.outro,
    chapters: tl.chapters,
    cursorStart: tl.cursorStart,
    stageIn: tl.stageIn,
    stageOut: tl.stageOut,
    cards: tl.cards,
    chrome: tl.chrome,
    frames,
    moves,
    clicks,
    highlights,
    callouts,
    blur,
    cameras,
    captions,
    chips,
    audio,
  };
}

function frameFilesIn(slice: Record<string, unknown>): string[] {
  const files = (slice.frames as TimelineFrameCue[]).map((f) => f.src);
  // The entry frame (the screenshot still on screen at t0, e.g. the last step's frame behind
  // the outro) isn't one of this scene's own frame cues, so it isn't in `frames` above — but
  // its bytes are exactly what the player paints first, so they must be content-hashed too.
  const entrySrc = (slice.entryState as { frame: { src: string } }).frame.src;
  return [...files, entrySrc];
}

function audioFilesIn(slice: Record<string, unknown>): string[] {
  return (slice.audio as TimelineAudioCue[]).map((a) => a.file);
}

/** Hashes one player asset file's bytes — same player.js/player.css/index.html for every scene
 * of a given render, but a player asset change (e.g. a motion tweak) must invalidate every
 * scene's cache. */
function playerAssetsHash(assetsDir: string): string {
  const hash = createHash("sha256");
  for (const f of ["index.html", "player.js", "player.css"]) {
    const file = path.join(assetsDir, f);
    hash.update(existsSync(file) ? readFileSync(file) : Buffer.from(`missing:${f}`));
  }
  return hash.digest("hex");
}

/** Computes one scene's content hash: its own timeline slice, its own frame/audio files (by
 * content, cached per path+size+mtime), the player assets, and render settings. */
export function computeSceneHash(
  tl: Timeline,
  scene: TimelineScene,
  assetsDir: string,
  settings: HashSettings,
  cache: FileHashCache,
): string {
  const slice = sliceTimelineForScene(tl, scene);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(slice));
  hash.update(JSON.stringify(settings));
  hash.update(playerAssetsHash(assetsDir));
  const files = [...new Set([...frameFilesIn(slice), ...audioFilesIn(slice)])].sort();
  for (const f of files) hash.update(hashFileCached(f, cache));
  return hash.digest("hex");
}
