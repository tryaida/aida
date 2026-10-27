// Turns a Walkthrough + its capture + its narration into the finished video, captions and
// chapters. Port of the original pipeline's compose.mjs, generalised off its one app.
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Walkthrough } from "../walkthrough/types.js";
import { resolveFfmpegTools } from "../qa/ffmpeg.js";
import { buildNarrationTrack } from "./audio.js";
import { playerAssetFiles, writePlayerBundle } from "./bundle.js";
import type { CaptureManifest, ValidationResult } from "../capture/index.js";
import { captionsFor } from "./captions.js";
import {
  computeContentHash,
  loadFileHashCache,
  matchesCachedHash,
  saveFileHashCache,
  writeHashSidecar,
  type HashSettings,
} from "./hash.js";
import { renderScenesToSegments } from "./segments.js";
import { beatIds, buildTimeline } from "./timeline.js";
import type { RenderOptions, RenderResult } from "./types.js";
import { muxVideo, qualityFor, renderStills } from "./video.js";

export * from "./types.js";
export { beatIds, buildTimeline } from "./timeline.js";
export { captionsFor, toSrt, toVtt, toChaptersVtt, wrapCaption, wrapCaptions } from "./captions.js";
export { computeContentHash, matchesCachedHash, writeHashSidecar, hashSidecarPath } from "./hash.js";
export { writePlayerBundle } from "./bundle.js";
export {
  resolveArtifactBrand,
  timelineBrand,
  cssColor,
  fontStack,
  imageDataUrl,
  brandFingerprint,
  NEUTRAL_COLORS,
  type ArtifactBrand,
  type ArtifactColors,
  type BrandConfigLike,
} from "./brand.js";
export { loadNarrationBeats } from "./voice-input.js";
export { qualityFor, renderFrames, renderStills, muxVideo } from "./video.js";
export { buildNarrationTrack } from "./audio.js";
export {
  computeSceneHash,
  defaultConcurrency,
  frameRangesForScenes,
  renderScenesToSegments,
  segmentPath,
  sliceTimelineForScene,
} from "./segments.js";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Sidecar caching each referenced frame/audio file's sha256 by path+size+mtime (hash.ts), so
 * neither the whole-video hash nor any scene's hash re-reads an unchanged file's bytes. Shared
 * across draft/full renders of the same capture — content hashes don't depend on quality. */
function hashCachePath(captureDir: string): string {
  return path.join(captureDir, ".aida-hash-cache.json");
}

/**
 * Renders `wf` into `<outDir>/<id>/`: `<id>.mp4`, `.srt`, `.vtt`, `.chapters.vtt`, `timeline.json`.
 *
 * Whole-video skip: skips everything (reporting `skipped: true`) if a `.hash` sidecar on the
 * output already matches the content hash of this run's timeline + referenced files + settings.
 *
 * Otherwise renders per scene (docs/scope.md "Only rebuild what changed": "A video re-renders
 * only if one of its scenes changed") — intro, each step, outro — each to its own cached segment
 * keyed by a hash of exactly that scene's own inputs, rendered concurrently, then concatenated
 * (ffmpeg concat demuxer, `-c copy`) before muxing in the narration track.
 */
export async function render(wf: Walkthrough, optionsIn: RenderOptions): Promise<RenderResult> {
  // Frame paths end up in the player bundle as absolute paths; a relative capture dir (e.g. a
  // `--capture .build/x/capture` typed on the command line) would make them relative to the
  // bundle instead and render blank screens.
  const options: RenderOptions = { ...optionsIn, captureDir: path.resolve(optionsIn.captureDir) };
  const id = wf.walkthrough;
  const manifest = readJson<CaptureManifest>(path.join(options.captureDir, "manifest.json"));
  const validationPath = path.join(options.captureDir, "validation.json");
  if (existsSync(validationPath)) {
    const validation = readJson<ValidationResult>(validationPath);
    if (!validation.ok && !options.force) {
      throw new Error(`capture validation failed for ${id} — fix the walkthrough or pass force`);
    }
  }

  for (const b of beatIds(wf)) {
    if (!options.narration[b]) throw new Error(`narration for "${b}" is missing — run voice first`);
  }

  const draft = Boolean(options.draft);
  const quality = qualityFor(draft, options.fps);
  const frameSrc = (f: string) => path.join(options.captureDir, "frames", f);
  const timeline = buildTimeline(wf, manifest, options.narration, {
    fps: quality.fps,
    frameSrc,
    brand: options.brand,
    zoomToTarget: options.zoomToTarget,
  });

  const stepOutDir = path.join(options.outDir, id);
  await mkdir(stepOutDir, { recursive: true });
  const mp4 = path.join(stepOutDir, `${id}.mp4`);
  const srtFile = path.join(stepOutDir, `${id}.srt`);
  const vttFile = path.join(stepOutDir, `${id}.vtt`);
  const chaptersFile = path.join(stepOutDir, `${id}.chapters.vtt`);
  const timelineJsonFile = path.join(stepOutDir, "timeline.json");

  const { srt, vtt, chaptersVtt } = captionsFor(timeline);
  await writeFile(srtFile, srt);
  await writeFile(vttFile, vtt);
  await writeFile(chaptersFile, chaptersVtt);
  await writeFile(timelineJsonFile, `${JSON.stringify(timeline, null, 2)}\n`);

  const fileHashCache = loadFileHashCache(hashCachePath(options.captureDir));

  const stillsRequested = options.stills ?? [];
  const settings: HashSettings = { fps: quality.fps, crf: quality.crf, preset: quality.preset, draft };
  const referencedFiles = [
    ...new Set([
      ...timeline.frames.map((f) => frameSrcToPath(f.src, options.captureDir)),
      ...timeline.audio.map((a) => a.file),
      ...(await playerAssetFiles()),
    ]),
  ];
  const hash = computeContentHash(timeline, referencedFiles, settings, fileHashCache);
  saveFileHashCache(hashCachePath(options.captureDir), fileHashCache);

  const wantsFullRender = stillsRequested.length === 0;
  if (wantsFullRender && !options.noCache && matchesCachedHash(mp4, hash)) {
    return {
      id,
      outDir: stepOutDir,
      mp4,
      srt: srtFile,
      vtt: vttFile,
      chaptersVtt: chaptersFile,
      timelineJson: timelineJsonFile,
      stills: [],
      durationSec: timeline.duration,
      skipped: true,
      frames: Math.ceil(timeline.duration * quality.fps),
      wallTimeMs: 0,
    };
  }

  const bundleDir = path.join(stepOutDir, ".compose");
  await writePlayerBundle(bundleDir, timeline);

  if (stillsRequested.length > 0) {
    const stills = await renderStills(bundleDir, stillsRequested);
    return {
      id,
      outDir: stepOutDir,
      srt: srtFile,
      vtt: vttFile,
      chaptersVtt: chaptersFile,
      timelineJson: timelineJsonFile,
      stills,
      durationSec: timeline.duration,
      skipped: false,
      frames: 0,
      wallTimeMs: 0,
    };
  }

  const tools = await resolveFfmpegTools({ ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });

  // Draft and full cache separately: each quality gets its own segments directory, so a draft
  // preview never evicts (or gets confused with) the full-quality segments for the same step.
  const segmentsDir = path.join(stepOutDir, "segments", draft ? "draft" : "full");
  const { outFile: silentVideo, report } = await renderScenesToSegments({
    bundleDir,
    segmentsDir,
    timeline,
    quality,
    settings,
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    concurrency: options.concurrency,
    cache: fileHashCache,
  });
  saveFileHashCache(hashCachePath(options.captureDir), fileHashCache);

  // Audio mix is cheap (small clips through one ffmpeg filter graph) — redo it whenever any
  // audio changes rather than caching it separately.
  const narrationTrack = await buildNarrationTrack(timeline, bundleDir, tools.ffmpeg);
  await copyFile(narrationTrack, path.join(bundleDir, "narration.m4a"));
  await muxVideo(silentVideo, narrationTrack, mp4, `${wf.title}`, tools.ffmpeg);
  writeHashSidecar(mp4, hash);

  return {
    id,
    outDir: stepOutDir,
    mp4,
    srt: srtFile,
    vtt: vttFile,
    chaptersVtt: chaptersFile,
    timelineJson: timelineJsonFile,
    stills: [],
    durationSec: timeline.duration,
    skipped: false,
    frames: Math.ceil(timeline.duration * quality.fps),
    wallTimeMs: report.wallTimeMs,
    scenesTotal: report.scenesTotal,
    scenesRendered: report.scenesRendered,
    scenesReused: report.scenesReused,
  };
}

function frameSrcToPath(src: string, captureDir: string): string {
  // frameSrc() above writes absolute paths under <captureDir>/frames already.
  return path.isAbsolute(src) ? src : path.resolve(captureDir, src);
}
