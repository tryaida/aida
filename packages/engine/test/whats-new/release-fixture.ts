// A small app on disk as the last build left it, for the release video tests (M48): walkthrough
// files (the ones that existed then committed at the base commit too), the build's
// publishability evidence, each guide's timeline.json, render record and cached scene segments
// (tiny synthetic ffmpeg clips, encoded like the real ones so `-c copy` joins them), and the help
// app as the build published it: staged pages, each guide's own video, and its screenshots in a
// git repo with a base commit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CaptureManifest } from "../../src/capture/index.js";
import { writePlayerBundle } from "../../src/render/bundle.js";
import { renderSourcePath, walkthroughHash } from "../../src/render/hash.js";
import { findSceneSegments } from "../../src/render/release-cut.js";
import { buildTimeline } from "../../src/render/timeline.js";
import type { NarrationBeat, RenderQuality, Timeline } from "../../src/render/types.js";
import { qualityFor } from "../../src/render/video.js";
import type { ReleaseVideoConfig } from "../../src/whats-new/release-video.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { solidPng, tmpDir } from "../ci/helpers.js";

export const FPS = 5;
export const QUALITY: RenderQuality = qualityFor(true, FPS);
export const SIZE = { w: 160, h: 90 };
/** Flat box burned into every scene of a guide with `blur: true`, in output pixels. */
export const BLUR_BOX = { x: 40, y: 30, w: 60, h: 30 };

export interface GuideSpec {
  id: string;
  title: string;
  steps: number;
  /** Step screenshot colours at the base commit; `null`: not published then (a new guide). */
  base: Record<number, [number, number, number]> | null;
  /** Colours now; steps not listed keep their base colour. */
  now?: Record<number, [number, number, number]>;
  /** What the build says about it; default all passing. */
  captureOk?: boolean;
  qaOk?: boolean;
  /** No segment files on disk (as if pruned or never rendered at this quality). */
  noSegments?: boolean;
  /** Scenes are random noise with a flat box (`BLUR_BOX`), as a blurred region is. */
  blur?: boolean;
  /** Writes no timeline.json (never rendered). */
  noVideo?: boolean;
  /** Step ids now, in page order; default `step-1` .. `step-<steps>`. */
  stepIds?: string[];
  /** Step ids at the base commit; default the same as now. `base` colours follow this order. */
  baseStepIds?: string[];
  /** Built but not on the help site (no staged page, no video there), as after a build that
   * unpublished it. */
  unpublished?: boolean;
  /** Title words; default `Step <n> of <title>`. */
  stepTitle?: (n: number) => string;
}

export interface Fixture {
  root: string;
  config: ReleaseVideoConfig;
  baseSha: string;
  /** Sine-tone narration clips, by spoken-text length. */
  voice: (text: string) => NarrationBeat;
  timelines: Map<string, Timeline>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" });
}

/** Encoder settings as render/video.ts's `spawnFrameEncoder` (closed GOP, bt709, tv range). */
function encodeArgs(frames: number): string[] {
  return [
    "-frames:v", String(frames),
    "-vf", "format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
    "-r", String(FPS), "-g", String(Math.max(1, frames)), "-sc_threshold", "0",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  ];
}

/** A plain coloured segment of `frames` frames. */
export function colourSegment(file: string, frames: number, colour: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  ffmpeg(["-f", "lavfi", "-i", `color=c=${colour}:s=${SIZE.w}x${SIZE.h}:r=${FPS}`, ...encodeArgs(frames), file]);
}

/** Noise everywhere but one flat grey box: what a scene with a blurred region looks like. */
export function blurredSegment(file: string, frames: number): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const b = BLUR_BOX;
  ffmpeg([
    "-f", "lavfi", "-i", `nullsrc=s=${SIZE.w}x${SIZE.h}:r=${FPS},geq=lum='random(1)*255':cb=128:cr=128,drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=0x808080:t=fill`,
    ...encodeArgs(frames),
    file,
  ]);
}

export const idsOf = (g: GuideSpec): string[] => g.stepIds ?? Array.from({ length: g.steps }, (_, i) => `step-${i + 1}`);

/** A walkthrough file for `g` with these step ids (step text numbered by id order). */
export function writeWalkthrough(dir: string, g: GuideSpec, ids = idsOf(g)): string {
  const steps = ids.map((id, i) => [
    `  - id: ${id}`,
    `    title: ${g.stepTitle ? g.stepTitle(i + 1) : `Step ${i + 1} of ${g.title}`}`,
    `    say: This is step ${i + 1}.`,
    "    actions: []",
  ].join("\n"));
  const file = join(dir, `${g.id}.yaml`);
  writeFileSync(file, [`walkthrough: ${g.id}`, "version: 1", `title: ${g.title}`, "product: Acme Events", "start:", "  page: /home", "steps:", ...steps, ""].join("\n"));
  return file;
}

export async function makeFixture(guides: GuideSpec[], opts: { siteUrl?: string } = {}): Promise<Fixture> {
  const root = tmpDir("m48-release-video-");
  const config: ReleaseVideoConfig = {
    configDir: root,
    buildDir: join(root, ".build"),
    outDir: join(root, "dist"),
    walkthroughsDir: join(root, "walkthroughs"),
    helpApp: join(root, "help"),
    lang: "en",
    ...(opts.siteUrl ? { publish: { siteUrl: opts.siteUrl } } : {}),
  } as ReleaseVideoConfig;
  mkdirSync(config.walkthroughsDir, { recursive: true });
  mkdirSync(join(config.helpApp!, "public"), { recursive: true });

  // Narration: one sine clip per duration, so loudness QA has something to measure.
  const voiceDir = join(root, "voice");
  mkdirSync(voiceDir, { recursive: true });
  const clips = new Map<number, string>();
  const voice = (text: string): NarrationBeat => {
    // Three lengths only: every clip is an ffmpeg run, and the machine is shared.
    const ms = text.length < 20 ? 800 : text.length < 36 ? 1600 : 2400;
    let file = clips.get(ms);
    if (!file) {
      file = join(voiceDir, `tone-${ms}.wav`);
      ffmpeg(["-f", "lavfi", "-i", `sine=frequency=330:duration=${ms / 1000}`, "-ac", "1", "-ar", "44100", file]);
      clips.set(ms, file);
    }
    return { audioPath: file, durationMs: ms };
  };

  // Published screenshots: base commit, then the working tree as the last build left it.
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  const shotsDir = (id: string) => join(config.helpApp!, "public", "screenshots", id);
  for (const g of guides) {
    if (!g.base) continue;
    const baseIds = g.baseStepIds ?? idsOf(g);
    writeWalkthrough(config.walkthroughsDir, g, baseIds);
    mkdirSync(shotsDir(g.id), { recursive: true });
    for (let n = 1; n <= baseIds.length; n++) writeFileSync(join(shotsDir(g.id), `step-${String(n).padStart(2, "0")}.png`), solidPng(8, 8, g.base[n] ?? [200, 200, 200]));
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  for (const g of guides) {
    rmSync(shotsDir(g.id), { recursive: true, force: true });
    mkdirSync(shotsDir(g.id), { recursive: true });
    const ids = idsOf(g);
    for (let n = 1; n <= ids.length; n++) {
      // Unless told otherwise, a step looks as it did at the base commit (matched by its id).
      const baseN = (g.baseStepIds ?? idsOf(g)).indexOf(ids[n - 1]) + 1;
      const colour = g.now?.[n] ?? (baseN > 0 ? g.base?.[baseN] : undefined) ?? [200, 200, 200];
      writeFileSync(join(shotsDir(g.id), `step-${String(n).padStart(2, "0")}.png`), solidPng(8, 8, colour));
    }
  }

  const timelines = new Map<string, Timeline>();
  for (const g of guides) {
    const file = writeWalkthrough(config.walkthroughsDir, g);
    const buildId = join(config.buildDir, g.id);
    const captureDir = join(buildId, "capture");
    mkdirSync(join(captureDir, "frames"), { recursive: true });
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify({ ok: g.captureOk ?? true, steps: [] }));
    writeFileSync(join(buildId, "pages-cache.json"), JSON.stringify({ hash: "x", result: { publishable: true } }));
    writeFileSync(join(buildId, "qa.json"), JSON.stringify({ ok: g.qaOk ?? true, reports: [] }));
    if (!g.unpublished) {
      const page = join(config.helpApp!, "content", "docs", "how-do-i", g.id);
      mkdirSync(page, { recursive: true });
      writeFileSync(join(page, "index.mdx"), `---\ntitle: "${g.title}"\nwalkthrough: ${g.id}\npassed: true\n---\n\n# ${g.title}\n`);
    }
    if (g.noVideo) continue;

    const wf = loadWalkthroughFile(file);
    const manifest: CaptureManifest = {
      workflow: g.id,
      baseUrl: "http://localhost",
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 1,
      steps: wf.steps.map((s, i) => {
        const image = `${g.id}-${i + 1}.png`;
        writeFileSync(join(captureDir, "frames", image), PNG.sync.write(Object.assign(new PNG({ width: 4, height: 4 }), {})));
        return {
          id: s.id!,
          camera: "full",
          cameraBox: null,
          events: [{ type: "frame", image, transition: "cut" }, { type: "hold", seconds: 0.4 }],
          doc: { image, highlights: [] },
          impact: { urls: [], requests: [] },
          checks: [],
        };
      }),
    } as CaptureManifest;
    const narration: Record<string, NarrationBeat> = { intro: voice("intro"), outro: voice("outro") };
    for (const s of wf.steps) narration[s.id!] = voice(s.say!);
    const tl = buildTimeline(wf, manifest, narration, { fps: FPS, frameSrc: (f) => join(captureDir, "frames", f) });
    timelines.set(g.id, tl);
    const videoDir = join(config.outDir, "videos", g.id);
    mkdirSync(videoDir, { recursive: true });
    writeFileSync(join(videoDir, "timeline.json"), `${JSON.stringify(tl, null, 2)}\n`);
    writeFileSync(renderSourcePath(videoDir), `${JSON.stringify({ walkthrough: walkthroughHash(wf) })}\n`);
    await writePlayerBundle(join(videoDir, ".compose"), tl);
    // The guide's own video, in the render dir and (published) on the site, as the index stage
    // stages it.
    writeFileSync(join(videoDir, `${g.id}.mp4`), "the guide's own video");
    if (!g.unpublished) {
      mkdirSync(join(config.helpApp!, "public", "videos", g.id), { recursive: true });
      writeFileSync(join(config.helpApp!, "public", "videos", g.id, `${g.id}.mp4`), "the guide's own video");
    }
    if (g.noSegments) continue;
    const segs = findSceneSegments(
      tl,
      // The release cut never uses a guide's own intro and outro.
      tl.scenes!.map((s) => s.id).filter((id) => id !== "intro" && id !== "outro"),
      { assetsDir: join(videoDir, ".compose"), segmentsDir: join(videoDir, "segments", "draft"), quality: QUALITY, draft: true },
    );
    for (const seg of segs) {
      if (g.blur) blurredSegment(seg.file, seg.end - seg.start);
      else colourSegment(seg.file, seg.end - seg.start, "0x3060a0");
    }
  }
  return { root, config, baseSha, voice, timelines };
}

/** The card renderer the tests use: a plain coloured clip of the card's length, encoded like
 * every scene (the real one opens the player in Chromium). */
export async function fakeCardRenderer(tl: Timeline, ctx: { segmentsDir: string }): Promise<string> {
  const scene = tl.scenes![0];
  const frames = Math.round(scene.t1 * FPS);
  const file = join(ctx.segmentsDir, `${scene.id}-${frames}.mp4`);
  if (!existsSync(file)) colourSegment(file, frames, "0xd0d0d0");
  return file;
}
