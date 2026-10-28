// Per-scene rendering (docs/scope.md "Only rebuild what changed": "A video re-renders only if
// one of its scenes changed"). The timeline is split into scenes — intro, each step, outro
// (see timeline.ts's `tl.scenes`, built alongside the cues) — and each scene is rendered to its
// own segment file, keyed by a hash of exactly the inputs that scene uses: its own frames, its
// own slice of timeline cues, the player assets, and the render settings. A rerun where only one
// step changed re-renders only that step's segment; every other scene's segment file already
// exists under its (unchanged) hash and is reused untouched. Segments are concatenated with the
// ffmpeg concat demuxer (`-c copy`, no re-encode) to build the silent video before muxing audio.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FileHashCache, HashSettings } from "./hash.js";
import { hashFileCached } from "./hash.js";
import { stateAt } from "./state.js";
import type {
  RenderQuality,
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
import { concatSegments, isPartialSegmentFile, openRenderBrowser, renderFrameRange, type FrameRange } from "./video.js";

const execFileAsync = promisify(execFile);

/** Default concurrency for parallel scene rendering: one browser page per CPU (capped at 8) so a
 * cold render actually uses the host it's given — each worker spends almost all of its time
 * waiting on Chromium's per-frame `page.evaluate`/`screenshot` round trip (profiled: ~110 s wall
 * across 17 scenes/1693 frames at concurrency 2 on a 4-core host), not burning a whole CPU core
 * itself, so running one worker per core (not per two cores, M10's original `cpus/2`) roughly
 * doubles throughput without starving the host any more than a single full-quality `-preset
 * slow` ffmpeg encode already would. */
export function defaultConcurrency(freeBytes: number = os.freemem(), cpus: number = os.cpus().length || 1): number {
  // Each worker is a Chromium page plus an ffmpeg encode, a few hundred MB together: on a small or
  // busy machine one per CPU runs it out of memory, so also keep to what's free.
  const byMemory = Math.floor(freeBytes / RENDER_WORKER_BYTES);
  return Math.max(1, Math.min(8, cpus, byMemory));
}

/** Memory one render worker (a Chromium page and its ffmpeg encode) is budgeted, in bytes. */
export const RENDER_WORKER_BYTES = 600 * 1024 * 1024;

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
    stage: tl.stage,
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

/** Short, filesystem-safe hash for segment filenames (`segments/<scene>-<hash>.mp4`). */
function shortHash(hash: string): string {
  return hash.slice(0, 16);
}

export function segmentPath(segmentsDir: string, sceneId: string, hash: string): string {
  return path.join(segmentsDir, `${sceneId}-${shortHash(hash)}.mp4`);
}

/** Maps each scene's `[t0, t1)` to a global frame range at `fps`. Frame boundaries are each
 * scene's own `t1 * fps` rounded once and shared with the next scene's `t0` (they're the same
 * timeline instant by construction — timeline.ts's scenes are contiguous), so frame counts
 * never drift or leave gaps: total frames rendered == `round(duration * fps)` exactly. */
export function frameRangesForScenes(scenes: TimelineScene[], fps: number): FrameRange[] {
  const boundaries = [0, ...scenes.map((s) => Math.round(s.t1 * fps))];
  return scenes.map((_, i) => ({ start: boundaries[i], end: boundaries[i + 1] }));
}

/** Best-effort check that a reused segment's duration matches its expected frame count, within
 * ±1 frame — a cheap guard against a truncated file left over from the exact crash this module
 * now avoids (a `.tmp-*` write that never got renamed can't appear at `file` any more, but an
 * older truncated segment from before this fix, or one truncated some other way, still could).
 * Returns `true` (assume OK) when no `ffprobe` is configured or the probe itself fails — this is
 * a defense in depth, not the primary correctness mechanism (the tmp-write+rename above is), so
 * it never turns "ffprobe isn't installed" into a render failure. */
async function reusedSegmentLooksValid(
  ffprobe: string | undefined,
  file: string,
  expectedFrames: number,
  fps: number,
): Promise<boolean> {
  if (!ffprobe) return true;
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration)) return true;
    const expectedSeconds = expectedFrames / fps;
    return Math.abs(duration - expectedSeconds) <= 1 / fps + 1e-6;
  } catch {
    return true;
  }
}

export interface SceneRenderReport {
  scenesTotal: number;
  scenesRendered: number;
  scenesReused: number;
  wallTimeMs: number;
  /** Total frames across all rendered scenes whose `frameSignature` matched the previous
   * frame's and so were repeated instead of screenshotted (M16 part 2). 0 when every scene was
   * reused from cache (nothing re-rendered this run). */
  framesSkipped: number;
}

/**
 * Renders every scene of `timeline` to `<segmentsDir>/<scene>-<hash>.mp4`, reusing any segment
 * whose filename already matches this run's hash for that scene, then concatenates all of them
 * (in scene order, `-c copy`) into `outFile`. Scenes needing a render run concurrently across
 * `concurrency` browser pages of one shared browser. Stale segments (this run's scene ids, but a
 * hash that no longer matches) are pruned so `segmentsDir` doesn't grow without bound.
 */
export async function renderScenesToSegments(opts: {
  bundleDir: string;
  segmentsDir: string;
  timeline: Timeline;
  quality: RenderQuality;
  settings: HashSettings;
  ffmpeg: string;
  /** Used only for the optional reused-segment duration sanity check below; reuse is skipped
   * (never failed) if this is omitted or the probe itself errors. */
  ffprobe?: string;
  concurrency?: number;
  cache: FileHashCache;
}): Promise<{ outFile: string; report: SceneRenderReport }> {
  const { bundleDir, segmentsDir, timeline, quality, settings, ffmpeg, ffprobe, cache } = opts;
  const scenes = timeline.scenes ?? [];
  mkdirSync(segmentsDir, { recursive: true });

  const assetsDir = bundleDir; // the bundle already holds a fresh copy of index.html/player.js/player.css
  const targets = scenes.map((scene) => {
    const hash = computeSceneHash(timeline, scene, assetsDir, settings, cache);
    return { scene, hash, file: segmentPath(segmentsDir, scene.id, hash) };
  });

  const ranges = frameRangesForScenes(scenes, quality.fps);
  const candidates = targets.map((target, i) => ({ ...target, range: ranges[i] }));
  const toRender: typeof candidates = [];
  for (const target of candidates) {
    if (!existsSync(target.file)) {
      toRender.push(target);
      continue;
    }
    const frames = target.range.end - target.range.start;
    const ok = await reusedSegmentLooksValid(ffprobe, target.file, frames, quality.fps);
    if (!ok) toRender.push(target);
  }

  const started = Date.now();
  let framesSkipped = 0;
  if (toRender.length > 0) {
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? defaultConcurrency(), toRender.length));
    const { pages, close } = await openRenderBrowser(bundleDir, quality.deviceScaleFactor, concurrency);
    try {
      let next = 0;
      const worker = async (page: import("playwright").Page) => {
        while (next < toRender.length) {
          const target = toRender[next++];
          const result = await renderFrameRange(page, target.range, quality, ffmpeg, target.file, timeline);
          framesSkipped += result.framesSkipped ?? 0;
        }
      };
      // Wait for every worker to settle (not just the first to reject) before closing the
      // browser: closing while sibling workers are still mid page.evaluate()/screenshot() turns
      // their next call into a "target page/context/browser has been closed" rejection that
      // nothing is left to observe (segments.ts used to race `close()` against `Promise.all`,
      // which resolves/rejects as soon as any one worker settles while the others keep running).
      const results = await Promise.allSettled(pages.map((page) => worker(page)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      await close();
    }
  }
  const wallTimeMs = Date.now() - started;
  if (process.env.AIDA_PROFILE === "1") {
    const totalFrames = ranges.length > 0 ? ranges[ranges.length - 1].end : 0;
    console.error(
      `[aida render profile] scenes ${targets.length - toRender.length}/${targets.length} reused, ` +
        `${toRender.length} rendered, ${framesSkipped}/${totalFrames} frames skipped (signature match), ` +
        `${wallTimeMs.toFixed(0)}ms`,
    );
  }

  // Prune segments for these scene ids whose hash no longer matches — keeps old quality
  // variants in their own directory untouched (segmentsDir is already draft- or full-specific).
  // Also sweep any leftover `.tmp-*` partial files (from a crash before this run) — never valid
  // segments, regardless of which scene id they belong to.
  const keep = new Set(targets.map((t) => path.basename(t.file)));
  const sceneIds = new Set(scenes.map((s) => s.id));
  if (existsSync(segmentsDir)) {
    for (const f of readdirSync(segmentsDir)) {
      if (isPartialSegmentFile(f)) {
        unlinkSync(path.join(segmentsDir, f));
        continue;
      }
      const sceneId = f.replace(/-[0-9a-f]+\.mp4$/, "");
      if (sceneIds.has(sceneId) && !keep.has(f)) unlinkSync(path.join(segmentsDir, f));
    }
  }

  const outFile = path.join(bundleDir, "video.mp4");
  await concatSegments(
    targets.map((t) => t.file),
    outFile,
    ffmpeg,
  );

  return {
    outFile,
    report: {
      scenesTotal: targets.length,
      scenesRendered: toRender.length,
      scenesReused: targets.length - toRender.length,
      wallTimeMs,
      framesSkipped,
    },
  };
}
