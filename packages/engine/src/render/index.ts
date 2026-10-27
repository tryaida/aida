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
import { frameChangeReader } from "./frame-change.js";
import { renderScenesToSegments } from "./segments.js";
import { beatIds, buildTimeline } from "./timeline.js";
import type { RenderOptions, RenderResult } from "./types.js";
import { muxVideo, qualityFor, renderStills } from "./video.js";
import { displayWalkthrough } from "../walkthrough/display.js";
import { pathsDeclareBlur, renderPathClips, taskRouteBlur } from "./clips.js";
import type { Timeline } from "./types.js";

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
export { pathClipFiles, pathClipLinks, renderPathClips, type PathClipFiles, type PathClipLink } from "./clips.js";
export { pathBeatId, pathClipLines, pathClipText, type PathClipText } from "./clip-lines.js";
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
export async function render(written: Walkthrough, optionsIn: RenderOptions): Promise<RenderResult> {
  // Frame paths end up in the player bundle as absolute paths; a relative capture dir (e.g. a
  // `--capture .build/x/capture` typed on the command line) would make them relative to the
  // bundle instead and render blank screens.
  const options: RenderOptions = { ...optionsIn, captureDir: path.resolve(optionsIn.captureDir) };
  // Captions, cards and chips show `{{data}}` filled in (M35).
  const wf = displayWalkthrough(written);
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
  // Blur is per screen across every capture of the task (M35): a screen blurred in a path's clip
  // is blurred in the main video too, and the other way round.
  const sharedBlur = taskRouteBlur(wf, manifest, options.captureDir);
  const timeline = buildTimeline(wf, manifest, options.narration, {
    fps: quality.fps,
    frameSrc,
    brand: options.brand,
    zoomToTarget: options.zoomToTarget,
    sharedBlur,
    blurDeclaredElsewhere: pathsDeclareBlur(wf),
    frameChange: frameChangeReader(options.captureDir, manifest.deviceScaleFactor),
  });

  const stepOutDir = path.join(options.outDir, id);
  await mkdir(stepOutDir, { recursive: true });
  const files = {
    mp4: path.join(stepOutDir, `${id}.mp4`),
    srt: path.join(stepOutDir, `${id}.srt`),
    vtt: path.join(stepOutDir, `${id}.vtt`),
    chaptersVtt: path.join(stepOutDir, `${id}.chapters.vtt`),
    timelineJson: path.join(stepOutDir, "timeline.json"),
  };
  const encoded = await encodeTimeline(timeline, files, {
    options,
    quality,
    draft,
    bundleDir: path.join(stepOutDir, ".compose"),
    segmentsDir: path.join(stepOutDir, "segments", draft ? "draft" : "full"),
    title: wf.title,
  });

  const base = {
    id,
    outDir: stepOutDir,
    srt: files.srt,
    vtt: files.vtt,
    chaptersVtt: files.chaptersVtt,
    timelineJson: files.timelineJson,
    durationSec: timeline.duration,
  };
  if (encoded.stills) return { ...base, stills: encoded.stills, skipped: false, frames: 0, wallTimeMs: 0 };

  // One short clip per path whose capture passed (M35), next to the main video.
  const clips = await renderPathClips(wf, timeline, {
    options,
    quality,
    draft,
    outDir: stepOutDir,
    sharedBlur,
    encode: encodeTimeline,
    frameChange: frameChangeReader,
  });

  return {
    ...base,
    mp4: files.mp4,
    stills: [],
    skipped: encoded.skipped,
    frames: Math.ceil(timeline.duration * quality.fps),
    wallTimeMs: encoded.wallTimeMs,
    ...(encoded.report
      ? { scenesTotal: encoded.report.scenesTotal, scenesRendered: encoded.report.scenesRendered, scenesReused: encoded.report.scenesReused }
      : {}),
    ...(clips.length > 0 ? { clips } : {}),
  };
}

/** Where one encode writes: the video, its captions and the timeline it was built from. */
export interface EncodeFiles {
  mp4: string;
  srt: string;
  vtt: string;
  /** Omitted for a path clip (it has no chapters). */
  chaptersVtt?: string;
  timelineJson: string;
}

export interface EncodeContext {
  options: RenderOptions;
  quality: ReturnType<typeof qualityFor>;
  draft: boolean;
  bundleDir: string;
  segmentsDir: string;
  title: string;
  /** Default true. False: never render stills (a path clip). */
  stills?: boolean;
}

export interface EncodeResult {
  skipped: boolean;
  wallTimeMs: number;
  report?: { scenesTotal: number; scenesRendered: number; scenesReused: number };
  /** Set when stills were asked for instead of a video. */
  stills?: string[];
}

/**
 * Writes `timeline`'s captions and JSON, then its video: skipped whole when the `.hash` sidecar
 * on the mp4 matches the content hash of the timeline + every referenced file + settings;
 * otherwise rendered per scene (each scene a cached segment keyed by its own inputs, rendered
 * concurrently), concatenated (`-c copy`) and muxed with the narration track.
 */
export async function encodeTimeline(timeline: Timeline, files: EncodeFiles, ctx: EncodeContext): Promise<EncodeResult> {
  const { options, quality, draft } = ctx;
  const { srt, vtt, chaptersVtt } = captionsFor(timeline);
  await writeFile(files.srt, srt);
  await writeFile(files.vtt, vtt);
  if (files.chaptersVtt) await writeFile(files.chaptersVtt, chaptersVtt);
  await writeFile(files.timelineJson, `${JSON.stringify(timeline, null, 2)}\n`);

  const fileHashCache = loadFileHashCache(hashCachePath(options.captureDir));
  const stillsRequested = ctx.stills === false ? [] : (options.stills ?? []);
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

  if (stillsRequested.length === 0 && !options.noCache && matchesCachedHash(files.mp4, hash)) {
    return { skipped: true, wallTimeMs: 0 };
  }

  await writePlayerBundle(ctx.bundleDir, timeline);
  if (stillsRequested.length > 0) {
    return { skipped: false, wallTimeMs: 0, stills: await renderStills(ctx.bundleDir, stillsRequested) };
  }

  const tools = await resolveFfmpegTools({ ffmpegPath: options.ffmpegPath, ffprobePath: options.ffprobePath });
  // Draft and full cache separately: each quality gets its own segments directory, so a draft
  // preview never evicts (or gets confused with) the full-quality segments for the same step.
  const { outFile: silentVideo, report } = await renderScenesToSegments({
    bundleDir: ctx.bundleDir,
    segmentsDir: ctx.segmentsDir,
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
  const narrationTrack = await buildNarrationTrack(timeline, ctx.bundleDir, tools.ffmpeg);
  await copyFile(narrationTrack, path.join(ctx.bundleDir, "narration.m4a"));
  await muxVideo(silentVideo, narrationTrack, files.mp4, ctx.title, tools.ffmpeg);
  writeHashSidecar(files.mp4, hash);
  return {
    skipped: false,
    wallTimeMs: report.wallTimeMs,
    report: { scenesTotal: report.scenesTotal, scenesRendered: report.scenesRendered, scenesReused: report.scenesReused },
  };
}

function frameSrcToPath(src: string, captureDir: string): string {
  // frameSrc() above writes absolute paths under <captureDir>/frames already.
  return path.isAbsolute(src) ? src : path.resolve(captureDir, src);
}
