// `aida whats-new --video` (decision 45; M48): one "what changed" video per release, cut from
// what the last build left on disk — no model, no capture, no walkthrough rendering.
//
//   1. Only publishable guides take part: capture passed, page publishable, QA passed (the
//      build's own `validation.json`, `pages-cache.json` and `qa.json`), and published right now
//      (its page staged in the help app and its own video on the site). A guide whose walkthrough
//      changed since its last render stops the run: its scenes and its file would disagree.
//   2. changes.ts decides which steps changed since the base ref, and by which rule.
//   3. Guides and steps are capped (and fitted to a time budget) so the video stays short; what's
//      left out is listed in the output and on the page.
//   4. Every scene is the build's own cached segment (render/release-cut.ts); a missing or stale
//      one stops the video and names the build command that makes it.
//   5. Cards get a spoken line through the configured voice provider and its cache, and are
//      rendered through the same player; the cut gets captions, chapters and a transcript.
//   6. The result passes the same QA gates as every video before it's copied into the help app's
//      `public/videos/_whats-new/` (a folder no walkthrough id can name) and onto the page, with a
//      manifest of what it was cut from (published.ts): every build checks it and takes the
//      video down once any guide in it changes. A run that publishes nothing new runs the same
//      check on the video already there, and takes it down when it might now be wrong.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findStagedPages } from "../build/library.js";
import type { ResolvedConfig } from "../config/types.js";
import { listWalkthroughs } from "../impact/walkthroughs.js";
import type { GeneratedBlock } from "../pages/markers.js";
import { runQa, type QaReport } from "../qa/run.js";
import { resolveFfmpegTools } from "../qa/ffmpeg.js";
import { loadFileHashCache, renderSourcePath, walkthroughHash, type FileHashCache } from "../render/hash.js";
import {
  assembleCut,
  buildCardTimeline,
  cardSeconds,
  encodeReleaseCut,
  findSceneSegments,
  renderCardSegment,
  sceneAssetsDir,
  sceneHashSettings,
  segmentLengthMatches,
  type CutPiece,
  type ReleaseCardText,
  type ReleaseCutFiles,
} from "../render/release-cut.js";
import { frameRangesForScenes } from "../render/segments.js";
import type { NarrationBeat, RenderQuality, Timeline } from "../render/types.js";
import { qualityFor } from "../render/video.js";
import { devicesFor, primaryCaptureDir, stepsFor } from "../devices/resolve.js";
import { briefPath, loadBrief } from "../brief/consumers.js";
import { displayWalkthrough } from "../walkthrough/display.js";
import { loadWalkthroughFile } from "../walkthrough/loader.js";
import { libraryPlacement } from "../walkthrough/placement.js";
import type { Walkthrough } from "../walkthrough/types.js";
import type { BaselineSource } from "../ci/baseline.js";
import { detectReleaseChanges, refLooksSafe, type AffectedLookup, type BaseWalkthroughLookup, type ChangeRule, type GuideChange } from "./changes.js";
import {
  checkPublishedReleaseVideo,
  RELEASE_BASENAME,
  RELEASE_MANIFEST,
  RELEASE_VIDEO_DIR,
  releaseStagedNames,
  takeDownReleaseVideo,
  writeReleaseManifest,
  type ReleaseManifest,
} from "./published.js";
import {
  closingCard,
  guideCard,
  openingCard,
  readerLabel,
  releaseTitle,
  releaseTranscript,
  siteLabel,
  videoBlock,
  type LeftOutGuide,
  type ReleaseGuideText,
  type ReleaseVideoUrls,
} from "./release-text.js";

export { RELEASE_VIDEO_DIR } from "./published.js";
const BASENAME = RELEASE_BASENAME;

export const DEFAULT_MAX_GUIDES = 4;
export const DEFAULT_MAX_STEPS_PER_GUIDE = 3;
/** "Two minutes or less". */
export const DEFAULT_MAX_SECONDS = 120;

export type ReleaseVideoConfig = Pick<
  ResolvedConfig,
  "configDir" | "buildDir" | "outDir" | "walkthroughsDir" | "helpApp" | "lang" | "publish" | "devices" | "brief"
>;

/** Spoken lines for the cards, through the configured voice provider and its cache. */
export type CardNarrator = (lines: { id: string; text: string }[]) => Promise<Record<string, NarrationBeat>>;

export interface BuildReleaseVideoOptions {
  config: ReleaseVideoConfig;
  /** Git ref the release is measured from; unset: no video (there's nothing to compare with). */
  base?: string;
  /** Version name for the opening card (e.g. "2.4"); default `dateLabel`. */
  release?: string;
  /** The date the opening card shows when there's no version name, e.g. "11 November 2026". */
  dateLabel: string;
  maxGuides?: number;
  maxStepsPerGuide?: number;
  maxSeconds?: number;
  /** Cut the draft segments (`aida build --draft`) instead of the full-quality ones. */
  draft?: boolean;
  /** Frame-rate override, as `render` takes it (tests). */
  fps?: number;
  /** `capture.frameDiffTolerance`. */
  tolerance: number;
  /** `capture.frameDiffThreshold`: the least share of pixels that makes a step changed. */
  threshold?: number;
  narrate: CardNarrator;
  /** Impact-map fallback for guides whose screenshots can't be compared. */
  affected?: AffectedLookup;
  /** Screenshot baseline override (tests). */
  baseline?: BaselineSource;
  /** Base-ref walkthrough override (tests). */
  baseWalkthroughs?: BaseWalkthroughLookup;
  /** Card renderer override (tests); default: the player, through `renderCardSegment`. */
  renderCard?: (tl: Timeline, ctx: { bundleDir: string; segmentsDir: string; quality: RenderQuality; draft: boolean }) => Promise<string>;
  /** QA override (tests); default: `runQa` on each file, as the build runs it. */
  qa?: (files: string[]) => Promise<QaReport[]>;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Stops the run: every ffmpeg and ffprobe it started is killed. */
  signal?: AbortSignal;
}

export type ReleaseVideoStatus =
  | "written"
  | "unchanged"
  | "nothing-changed"
  | "no-base"
  /** No guide could be checked, or none could be shown changed and some couldn't be told. */
  | "cant-tell"
  /** A guide's walkthrough changed since its last render. */
  | "stale-render"
  | "missing-segments"
  | "qa-failed";

export interface ReleaseVideoGuide {
  id: string;
  title: string;
  rule: ChangeRule;
  reason: string;
  /** Page step numbers in the video. */
  steps: number[];
}

export interface ReleaseVideoLeftOut {
  id: string;
  title: string;
  /** Steps left out; empty when the whole guide was. */
  steps: number[];
  reason: string;
  /** The caps or time budget ("short"), a different frame shape, or another device's steps. */
  why: "short" | "shape" | "device";
}

export interface ReleaseVideoResult {
  status: ReleaseVideoStatus;
  ok: boolean;
  /** One line saying what happened. */
  message: string;
  base?: string;
  guides: ReleaseVideoGuide[];
  leftOut: ReleaseVideoLeftOut[];
  /** Guides that took no part: not publishable, or what changed couldn't be told. */
  excluded: { id: string; reason: string }[];
  /** Scenes with no current segment, when `status` is "missing-segments". */
  missing?: { id: string; step: number; stepId: string }[];
  /** Guides whose walkthrough changed since their last render, when `status` is "stale-render". */
  stale?: { id: string; reason: string }[];
  /** The build command that makes them. */
  buildCommand?: string;
  /** On a run that published nothing new: whether the video already on the site stays (still
   * true of every guide in it) or was taken down, and why. */
  previous?: { kept: boolean; reason?: string };
  durationSec?: number;
  files?: ReleaseCutFiles & { transcript: string };
  urls?: ReleaseVideoUrls;
  qa?: { ok: boolean; problems: string[]; file: string };
  /** The page's video block: new content, `null` to remove it, absent to leave it as it is. */
  block?: GeneratedBlock | null;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Ids of the walkthrough pages staged in the help app now. */
export function stagedGuideIds(helpApp: string): Set<string> {
  return new Set(findStagedPages(join(helpApp, "content", "docs")).map((p) => p.id));
}

/** Why a guide can't appear in a published video, or undefined when it can. Read from what the
 * last build wrote — the same evidence `aida build` publishes a page on — and from what it
 * published: a build can unpublish a guide without rewriting those files (a QA run that never
 * ran, a text problem), so with a help app the guide's page and own video must be on the site
 * now. `staged` is `stagedGuideIds(helpApp)`, when the caller already has it. */
export function unpublishableReason(
  config: Pick<ResolvedConfig, "buildDir"> & { helpApp?: string },
  id: string,
  captureDir: string,
  staged?: ReadonlySet<string>,
): string | undefined {
  const validation = readJson<{ ok?: boolean }>(join(captureDir, "validation.json"));
  if (!validation) return "not captured yet";
  if (validation.ok !== true) return "its capture didn't pass";
  const page = readJson<{ result?: { publishable?: boolean } }>(join(config.buildDir, id, "pages-cache.json"));
  if (page?.result?.publishable !== true) return "its page isn't publishable";
  const qa = readJson<{ ok?: boolean }>(join(config.buildDir, id, "qa.json"));
  if (!qa) return "QA hasn't run on it";
  if (qa.ok !== true) return "it failed QA";
  if (config.helpApp) {
    if (!(staged ?? stagedGuideIds(config.helpApp)).has(id)) return "its page isn't on the help site (the last build didn't publish it)";
    if (!existsSync(join(config.helpApp, "public", "videos", id, `${id}.mp4`))) return "its video isn't on the help site";
  }
  return undefined;
}

export interface ReleaseVideoPaths {
  renderDir: string;
  files: ReleaseCutFiles & { transcript: string };
  publicDir?: string;
  urls: ReleaseVideoUrls;
}

export function releaseVideoPaths(config: Pick<ResolvedConfig, "outDir" | "helpApp">): ReleaseVideoPaths {
  const renderDir = join(config.outDir, "videos", RELEASE_VIDEO_DIR);
  const file = (ext: string) => join(renderDir, `${BASENAME}.${ext}`);
  const url = (ext: string) => `/videos/${RELEASE_VIDEO_DIR}/${BASENAME}.${ext}`;
  return {
    renderDir,
    files: { mp4: file("mp4"), srt: file("srt"), vtt: file("vtt"), chaptersVtt: file("chapters.vtt"), transcript: file("transcript.md") },
    ...(config.helpApp ? { publicDir: join(config.helpApp, "public", "videos", RELEASE_VIDEO_DIR) } : {}),
    urls: { src: url("mp4"), vtt: url("vtt"), srt: url("srt"), chapters: url("chapters.vtt"), transcript: url("transcript.md") },
  };
}

const stagedNames = releaseStagedNames;

/** Copies (never hard-links: the next cut must not change a published file in place) what
 * changed into the help app, then its manifest. The old manifest goes first, so a copy cut short
 * leaves files with no record (which the next build takes down), never a record of other files. */
function stageToHelpApp(paths: ReleaseVideoPaths, manifest: ReleaseManifest, helpApp: string): void {
  if (!paths.publicDir) return;
  mkdirSync(paths.publicDir, { recursive: true });
  rmSync(join(paths.publicDir, RELEASE_MANIFEST), { force: true });
  for (const name of stagedNames()) {
    const src = join(paths.renderDir, name);
    const dest = join(paths.publicDir, name);
    const s = statSync(src);
    if (existsSync(dest)) {
      const d = statSync(dest);
      if (d.size === s.size && d.mtimeMs === s.mtimeMs) continue;
    }
    copyFileSync(src, dest);
    utimesSync(dest, s.atime, s.mtime);
  }
  writeReleaseManifest(helpApp, manifest);
}

const RULE_ORDER: Record<ChangeRule, number> = { screenshots: 0, new: 1, impact: 2 };

interface Candidate {
  change: GuideChange;
  wf: Walkthrough;
  /** The walkthrough as loaded (no `{{data}}` filled in): what its hash is taken of. */
  loaded: Walkthrough;
  text: Omit<ReleaseGuideText, "steps">;
  timeline: Timeline;
  videoStepDir: string;
  captureDir: string;
  /** Steps in the guide's video, in order. */
  steps: { n: number; stepId: string; title: string; say: string }[];
}

interface Scene {
  n: number;
  stepId: string;
  title: string;
  say: string;
  file: string;
  hash: string;
  start: number;
  end: number;
}

interface KnownGuide {
  wf: Walkthrough;
  loaded: Walkthrough;
  file: string;
  captureDir: string;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const guideTitle = (wf: Walkthrough | undefined, id: string) => wf?.title ?? id;

/** A cap from the caller: unset is the default; anything else must be a whole number from 1 (a
 * NaN would otherwise switch the cap off, since `Math.max(1, NaN)` is NaN). */
function capOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of 1 or more, not ${value}`);
  return value;
}

/**
 * Builds the release video (see the module comment). Writes the video, its captions, chapters
 * and transcript under `<outDir>/videos/_whats-new/` and, once QA passes, into the help app.
 * The page itself is the caller's: `block` says what its video block should become.
 */
export async function buildReleaseVideo(opts: BuildReleaseVideoOptions): Promise<ReleaseVideoResult> {
  const { config } = opts;
  const paths = releaseVideoPaths(config);
  const maxGuides = capOption(opts.maxGuides, DEFAULT_MAX_GUIDES, "maxGuides");
  const maxSteps = capOption(opts.maxStepsPerGuide, DEFAULT_MAX_STEPS_PER_GUIDE, "maxStepsPerGuide");
  const budget = opts.maxSeconds ?? DEFAULT_MAX_SECONDS;
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError(`maxSeconds must be a number above 0, not ${opts.maxSeconds}`);
  const draft = Boolean(opts.draft);
  const buildCommandFor = (ids: string[]) => `aida build${ids.length > 0 ? ` ${ids.join(" ")}` : ""}${draft ? " --draft" : ""}`;

  // Every walkthrough as loaded, for the check on the video already published.
  const loadedById = new Map<string, Walkthrough>();
  const result = (r: Omit<ReleaseVideoResult, "base" | "guides" | "leftOut" | "excluded"> & Partial<ReleaseVideoResult>): ReleaseVideoResult => ({
    base: opts.base,
    guides: [],
    leftOut: [],
    excluded: [],
    ...r,
  });
  /** A run that publishes nothing new: the video already on the site stays only while every
   * guide in it is still as it was cut (the build's own check, published.ts); otherwise it comes
   * down with its page block, and the message says which. */
  const notPublished = (r: Omit<ReleaseVideoResult, "base" | "guides" | "leftOut" | "excluded" | "ok"> & Partial<ReleaseVideoResult>): ReleaseVideoResult => {
    if (!config.helpApp) return result({ ...r, ok: false });
    const check = checkPublishedReleaseVideo({ helpApp: config.helpApp, videoDir: join(config.outDir, "videos"), walkthroughs: loadedById.values() });
    if (!check.published) return result({ ...r, ok: false });
    if (check.current) {
      return result({ ...r, ok: false, previous: { kept: true }, message: `${r.message}; the video already on the site stays (none of its guides changed since it was made)` });
    }
    takeDownReleaseVideo(config.helpApp);
    return result({
      ...r,
      ok: false,
      previous: { kept: false, reason: check.reason },
      block: null,
      message: `${r.message}; the video already on the site was taken down (${check.reason})`,
    });
  };

  // 1. Publishable guides only, each rendered from the walkthrough as it is now.
  let brief;
  try {
    brief = loadBrief(briefPath(config));
  } catch {
    brief = undefined;
  }
  const excluded: { id: string; reason: string }[] = [];
  const stale: { id: string; reason: string }[] = [];
  const known = new Map<string, KnownGuide>();
  const staged = config.helpApp ? stagedGuideIds(config.helpApp) : undefined;
  for (const entry of listWalkthroughs(config.walkthroughsDir, config.buildDir, config)) {
    let loaded: Walkthrough;
    try {
      loaded = loadWalkthroughFile(entry.file);
    } catch (err) {
      excluded.push({ id: entry.id, reason: `can't be read: ${(err as Error).message.split("\n")[0]}` });
      continue;
    }
    loadedById.set(loaded.walkthrough, loaded);
    const wf = displayWalkthrough(loaded);
    const captureDir = primaryCaptureDir(config, loaded, brief);
    const why = unpublishableReason(config, wf.walkthrough, captureDir, staged);
    if (why) {
      excluded.push({ id: wf.walkthrough, reason: why });
      continue;
    }
    // The build renders the walkthrough's primary-device steps (pipeline.ts
    // `walkthroughForDevice`), and records the hash of what it rendered beside the video.
    const primary = devicesFor(loaded, config, brief)[0];
    const rendered = readJson<{ walkthrough?: string }>(renderSourcePath(join(config.outDir, "videos", wf.walkthrough)));
    if (rendered?.walkthrough !== walkthroughHash({ ...loaded, steps: stepsFor(loaded, primary) })) {
      stale.push({
        id: wf.walkthrough,
        reason: rendered ? "its walkthrough changed since its last build" : "its last build didn't record which walkthrough it rendered",
      });
    }
    known.set(wf.walkthrough, { wf, loaded, file: entry.file, captureDir });
  }
  excluded.sort((a, b) => a.id.localeCompare(b.id));

  if (!opts.base) {
    return notPublished({ status: "no-base", excluded, message: "no release to compare with: freeze a version first (aida version freeze) or pass --base <ref>" });
  }
  if (!refLooksSafe(opts.base)) {
    return notPublished({ status: "no-base", excluded, message: `"${opts.base}" can't be a git ref` });
  }
  if (stale.length > 0) {
    // Its scenes are from the last render, its steps, titles and words from the file: they'd
    // disagree, and a blur box added since would be missing from the cut.
    const buildCommand = buildCommandFor(stale.map((s) => s.id));
    return notPublished({
      status: "stale-render",
      excluded,
      stale,
      buildCommand,
      message: `${plural(stale.length, "guide")} changed since ${stale.length === 1 ? "its" : "their"} last build (${stale.map((s) => s.id).join(", ")}): run \`${buildCommand}\`, then this again`,
    });
  }
  if (known.size === 0) {
    const buildCommand = buildCommandFor([]);
    return notPublished({
      status: "cant-tell",
      excluded,
      buildCommand,
      message: `can't tell what changed: no guide is published to check${excluded.length > 0 ? "" : " (there are no walkthroughs)"}; run \`${buildCommand}\`, then this again`,
    });
  }

  // 2. What changed.
  const publicDir = config.helpApp ? join(config.helpApp, "public") : config.outDir;
  const detected = await detectReleaseChanges({
    guides: [...known.entries()].map(([id, g]) => ({ id, stepIds: g.loaded.steps.map((s) => s.id), file: g.file })),
    publicDir,
    base: opts.base,
    tolerance: opts.tolerance,
    threshold: opts.threshold,
    diffDir: join(config.buildDir, "whats-new", "diff"),
    affected: opts.affected,
    source: opts.baseline,
    baseWalkthroughs: opts.baseWalkthroughs,
  });
  excluded.push(...detected.undecided);
  excluded.sort((a, b) => a.id.localeCompare(b.id));

  if (detected.changes.length === 0) {
    if (detected.undecided.length > 0) {
      // Some guides couldn't be told either way: "nothing changed" would be a guess.
      return notPublished({
        status: "cant-tell",
        excluded,
        message: `can't tell whether ${plural(detected.undecided.length, "guide")} changed since ${opts.base} (${detected.undecided[0].reason}): pass a --base the help app's git history has, or run this where the app repo has ${opts.base} so the impact map can`,
      });
    }
    if (config.helpApp) takeDownReleaseVideo(config.helpApp);
    return result({ status: "nothing-changed", ok: true, excluded, message: `no guide changed since ${opts.base}: no video`, block: null });
  }

  // 3. Candidates, in a fixed order: screenshot changes, then new guides, then the impact map.
  const leftOut: ReleaseVideoLeftOut[] = [];
  const missing: { id: string; step: number; stepId: string }[] = [];
  const candidates: Candidate[] = [];
  const changes = [...detected.changes].sort((a, b) => RULE_ORDER[a.rule] - RULE_ORDER[b.rule] || a.id.localeCompare(b.id));
  for (const change of changes) {
    const { wf, loaded, captureDir } = known.get(change.id)!;
    const videoStepDir = join(config.outDir, "videos", change.id);
    const timeline = readJson<Timeline>(join(videoStepDir, "timeline.json"));
    if (!timeline?.scenes) {
      for (const n of change.steps) missing.push({ id: change.id, step: n, stepId: wf.steps[n - 1]?.id ?? "" });
      continue;
    }
    const inVideo = new Set(timeline.scenes.map((s) => s.id));
    const steps: Candidate["steps"] = [];
    const notInVideo: number[] = [];
    for (const n of change.steps) {
      const step = wf.steps[n - 1];
      if (step?.id && inVideo.has(step.id)) steps.push({ n, stepId: step.id, title: step.title ?? step.id, say: step.say ?? "" });
      else notInVideo.push(n);
    }
    if (notInVideo.length > 0) leftOut.push({ id: change.id, title: wf.title, steps: notInVideo, reason: "not in this guide's own video (another device's step)", why: "device" });
    if (steps.length === 0) continue;
    candidates.push({
      change,
      wf,
      loaded,
      timeline,
      videoStepDir,
      captureDir,
      steps,
      text: {
        id: change.id,
        title: wf.title,
        rule: change.rule,
        ...(readerLabel(wf.for) ? { reader: readerLabel(wf.for) } : {}),
        ...(wf.summary ? { summary: wf.summary.replace(/\s+/g, " ").trim() } : {}),
        stepCount: wf.steps.length,
        href: `/${libraryPlacement(wf.section, change.id).dir}`,
        ...(change.newKind ? { newKind: change.newKind } : {}),
        ...(change.renamedFrom ? { renamedFrom: change.renamedFrom.title } : {}),
      },
    });
  }

  // Caps by count; one frame shape per video (a phone-shaped guide can't join landscape ones).
  const shapeOf = (tl: Timeline) => `${tl.frame?.w ?? 1920}x${tl.frame?.h ?? 1080}`;
  const shape = candidates[0] ? shapeOf(candidates[0].timeline) : undefined;
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (shapeOf(c.timeline) !== shape) {
      leftOut.push({ id: c.change.id, title: c.wf.title, steps: c.steps.map((s) => s.n), reason: "its video is a different shape (phone or desktop) from the others", why: "shape" });
    } else if (chosen.length >= maxGuides) {
      leftOut.push({ id: c.change.id, title: c.wf.title, steps: c.steps.map((s) => s.n), reason: `at most ${plural(maxGuides, "guide")} per video`, why: "short" });
    } else {
      if (c.steps.length > maxSteps) {
        leftOut.push({ id: c.change.id, title: c.wf.title, steps: c.steps.slice(maxSteps).map((s) => s.n), reason: `at most ${plural(maxSteps, "step")} per guide`, why: "short" });
        c.steps = c.steps.slice(0, maxSteps);
      }
      chosen.push(c);
    }
  }
  if (chosen.length === 0 && missing.length === 0) {
    if (config.helpApp) takeDownReleaseVideo(config.helpApp);
    return result({ status: "nothing-changed", ok: true, excluded, leftOut, message: "no changed step is in a guide's video: no video", block: null });
  }

  // 4. Each scene's cached segment, exactly as the build left it, and as long as planned.
  const quality = qualityFor(draft, opts.fps);
  let tools: Awaited<ReturnType<typeof resolveFfmpegTools>> | undefined;
  const ffmpegTools = async () => (tools ??= await resolveFfmpegTools({ ffmpegPath: opts.ffmpegPath, ffprobePath: opts.ffprobePath }));
  const scenesOf = new Map<string, Scene[]>();
  for (const c of chosen) {
    const cache: FileHashCache = { ...loadFileHashCache(join(c.captureDir, ".aida-hash-cache.json")) };
    const found = findSceneSegments(
      c.timeline,
      c.steps.map((s) => s.stepId),
      {
        assetsDir: await sceneAssetsDir(join(c.videoStepDir, ".compose")),
        segmentsDir: join(c.videoStepDir, "segments", draft ? "draft" : "full"),
        quality,
        draft,
        cache,
      },
    );
    const scenes: Scene[] = [];
    for (const [i, seg] of found.entries()) {
      const s = c.steps[i];
      const whole = seg.exists && (await segmentLengthMatches((await ffmpegTools()).ffprobe, seg.file, seg.end - seg.start, quality.fps, opts.signal));
      if (!whole) missing.push({ id: c.change.id, step: s.n, stepId: s.stepId });
      else scenes.push({ ...s, file: seg.file, hash: seg.hash, start: seg.start, end: seg.end });
    }
    scenesOf.set(c.change.id, scenes);
  }
  if (missing.length > 0) {
    const buildCommand = buildCommandFor([...new Set(missing.map((m) => m.id))]);
    return notPublished({
      status: "missing-segments",
      excluded,
      leftOut,
      missing,
      buildCommand,
      message: `the last build has no current video for ${missing.length} changed step${missing.length === 1 ? "" : "s"}: run \`${buildCommand}\`, then this again`,
    });
  }

  // 5. Fit the time budget: cards and scenes, guide by guide; the first guide always shows.
  const site = siteLabel(config.publish?.siteUrl);
  const label = opts.release ?? opts.dateLabel;
  const title = releaseTitle(label);
  const changedCount = detected.changes.length;
  const sceneSeconds = (s: Scene) => (s.end - s.start) / quality.fps;
  const draftLines = [
    openingCard(label, opts.release, chosen.length, changedCount),
    ...chosen.map((c) => guideCard({ ...c.text, steps: c.steps })),
    ...(site ? [closingCard(site)] : []),
  ];
  const estimate = await opts.narrate(draftLines.map((l) => ({ id: l.id, text: l.say })));
  const secondsOf = (id: string) => cardSeconds(estimate[id] ?? { audioPath: "", durationMs: 0 });
  const budgetWords = budget >= 60 && budget % 60 === 0 ? plural(budget / 60, "minute") : plural(budget, "second");
  let used = secondsOf("opening") + (site ? secondsOf("closing") : 0);
  const shown: { c: Candidate; scenes: Scene[] }[] = [];
  for (const c of chosen) {
    const scenes = scenesOf.get(c.change.id)!;
    const card = secondsOf(`guide-${c.change.id}`);
    const fits: Scene[] = [];
    let t = used + card;
    for (const s of scenes) {
      if (t + sceneSeconds(s) > budget && !(shown.length === 0 && fits.length === 0)) break;
      fits.push(s);
      t += sceneSeconds(s);
    }
    if (fits.length === 0) {
      leftOut.push({ id: c.change.id, title: c.wf.title, steps: scenes.map((s) => s.n), reason: `keeps the video under ${budgetWords}`, why: "short" });
      continue;
    }
    if (fits.length < scenes.length) {
      leftOut.push({ id: c.change.id, title: c.wf.title, steps: scenes.slice(fits.length).map((s) => s.n), reason: `keeps the video under ${budgetWords}`, why: "short" });
    }
    shown.push({ c, scenes: fits });
    used = t;
  }

  // 6. Cards: final text, narration, rendered through the player in the first guide's look.
  const guideTexts: ReleaseGuideText[] = shown.map(({ c, scenes }) => ({ ...c.text, steps: scenes.map((s) => ({ n: s.n, title: s.title, say: s.say })) }));
  const opening = openingCard(label, opts.release, shown.length, changedCount);
  const guideCards = guideTexts.map(guideCard);
  const closing = site ? closingCard(site) : undefined;
  const cardTexts: ReleaseCardText[] = [opening, ...guideCards, ...(closing ? [closing] : [])];
  const beats = await opts.narrate(cardTexts.map((l) => ({ id: l.id, text: l.say })));
  const look = shown[0].c.timeline;
  const segmentsDir = join(paths.renderDir, "segments", draft ? "draft" : "full");
  const renderCard =
    opts.renderCard ??
    (async (tl: Timeline, ctx: { bundleDir: string; segmentsDir: string; quality: RenderQuality; draft: boolean }) => {
      const t = await ffmpegTools();
      return renderCardSegment(tl, { ...ctx, ffmpeg: t.ffmpeg, ffprobe: t.ffprobe });
    });
  const cardPiece = async (card: ReleaseCardText, chapter?: number): Promise<CutPiece> => {
    const beat = beats[card.id];
    if (!beat) throw new Error(`no narration for the "${card.id}" card`);
    const tl = buildCardTimeline(card, beat, look, quality.fps);
    const file = await renderCard(tl, { bundleDir: join(paths.renderDir, ".compose-cards", card.id), segmentsDir, quality, draft });
    const [range] = frameRangesForScenes(tl.scenes!, quality.fps);
    return { file, start: range.start, end: range.end, source: tl, ...(chapter !== undefined ? { chapter } : {}) };
  };

  const pieces: CutPiece[] = [await cardPiece(opening)];
  for (const [i, { c, scenes }] of shown.entries()) {
    pieces.push(await cardPiece(guideCards[i], i));
    const source: Timeline = { ...c.timeline, fps: quality.fps };
    for (const s of scenes) pieces.push({ file: s.file, start: s.start, end: s.end, source, chapter: i });
  }
  if (closing) pieces.push(await cardPiece(closing));

  // 7. The cut, its captions, chapters and transcript.
  const cut = assembleCut(
    pieces,
    shown.map(({ c }) => c.wf.title),
    quality.fps,
  );
  const encoded = await encodeReleaseCut(cut, paths.files, {
    workDir: join(paths.renderDir, ".compose"),
    ffmpeg: (await ffmpegTools()).ffmpeg,
    title,
    lang: config.lang,
    signal: opts.signal,
  });
  const guideStarts = cut.chapters.map((ch) => ch.t0);
  writeFileSync(
    paths.files.transcript,
    releaseTranscript(
      title,
      opening,
      guideTexts.map((guide, i) => ({ guide, card: guideCards[i], at: guideStarts[i] ?? 0 })),
      closing,
    ),
  );

  const guides: ReleaseVideoGuide[] = shown.map(({ c, scenes }) => ({
    id: c.change.id,
    title: c.wf.title,
    rule: c.change.rule,
    reason: c.change.reason,
    steps: scenes.map((s) => s.n),
  }));
  const base = { excluded, leftOut, guides, durationSec: cut.duration, files: paths.files };

  // 8. The same QA gates as every video, before anything reaches the help app.
  const targets = [paths.files.mp4, paths.files.srt, paths.files.vtt, paths.files.chaptersVtt, paths.files.transcript];
  const reports = await (opts.qa ?? ((files: string[]) => Promise.all(files.map((f) => runQa(f)))))(targets);
  const failedChecks = reports.flatMap((r) => r.checks.filter((c) => !c.ok));
  const qaFile = join(config.buildDir, "whats-new", "qa.json");
  mkdirSync(join(config.buildDir, "whats-new"), { recursive: true });
  writeFileSync(qaFile, `${JSON.stringify({ ok: failedChecks.length === 0, reports }, null, 2)}\n`);
  const problems = failedChecks.flatMap((c) => (c.problems.length > 0 ? c.problems.map((p) => `${c.check}: ${p}`) : [`${c.check}: ${c.details}`]));
  if (failedChecks.length > 0) {
    return notPublished({
      ...base,
      status: "qa-failed",
      qa: { ok: false, problems, file: qaFile },
      message: `the release video failed QA (${[...new Set(failedChecks.map((c) => c.check))].join(", ")}): not published`,
    });
  }

  if (config.helpApp) {
    stageToHelpApp(
      paths,
      {
        version: 1,
        settings: sceneHashSettings(quality, draft),
        guides: shown.map(({ c, scenes }) => ({
          id: c.change.id,
          walkthrough: walkthroughHash(c.loaded),
          scenes: scenes.map((s) => ({ id: s.stepId, hash: s.hash })),
        })),
      },
      config.helpApp,
    );
  }
  const leftOutText: LeftOutGuide[] = [];
  for (const l of leftOut) {
    const g = known.get(l.id);
    const partly = guides.some((s) => s.id === l.id);
    const existing = leftOutText.find((x) => x.title === guideTitle(g?.wf, l.id) && x.partly === partly && x.why === l.why);
    if (existing) existing.steps = [...new Set([...existing.steps, ...l.steps])].sort((a, b) => a - b);
    else leftOutText.push({ title: guideTitle(g?.wf, l.id), href: `/${libraryPlacement(g?.wf.section, l.id).dir}`, steps: [...l.steps], partly, why: l.why });
  }
  return result({
    ...base,
    status: encoded.skipped ? "unchanged" : "written",
    ok: true,
    urls: paths.publicDir ? paths.urls : undefined,
    qa: { ok: true, problems: [], file: qaFile },
    message: `${encoded.skipped ? "release video unchanged" : "wrote the release video"}: ${guides.length} guide${guides.length === 1 ? "" : "s"}, ${clock(cut.duration)}`,
    block: paths.publicDir ? videoBlock(title, paths.urls, guideTexts, leftOutText) : undefined,
  });
}
