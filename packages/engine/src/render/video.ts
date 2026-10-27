// Playwright renderAt(t) -> ffmpeg libx264 (yuv420p, bt709, tv range), then mux with the
// narration track and +faststart. Ported from compose.mjs lines ~232-280.
import { execFile, spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { frameSignature } from "./state.js";
import type { RenderQuality, Timeline } from "./types.js";

const execFileAsync = promisify(execFile);

export function qualityFor(draft: boolean, fpsOverride?: number): RenderQuality {
  // Draft trades resolution for speed via deviceScaleFactor (player.css lays out a fixed
  // 1920x1080 CSS canvas; a 0.5 scale factor screenshots it at 960x540 physical pixels without
  // touching layout math). Full renders at native 1:1. Draft fps is 10 (down from an earlier 15,
  // M16): a draft preview's job is "does this look right", not smoothness, and every frame not
  // rendered is one less `page.evaluate`/`screenshot` round trip — the dominant cost of a cold
  // render (profiled: ~110 s wall across 1693 frames before this change, concurrency aside).
  // Screenshot JPEG quality is lower for draft too (80 vs full's 95) — a smaller buffer per
  // frame piped into ffmpeg, never published.
  if (draft) return { fps: fpsOverride ?? 10, crf: 30, preset: "ultrafast", deviceScaleFactor: 0.5, screenshotQuality: 80 };
  return { fps: fpsOverride ?? 30, crf: 17, preset: "slow", deviceScaleFactor: 1, screenshotQuality: 95 };
}

async function openBrowser(): Promise<import("playwright").Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch();
}

async function openPage(
  browser: import("playwright").Browser,
  bundleDir: string,
  deviceScaleFactor = 1,
): Promise<import("playwright").Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor });
  page.on("pageerror", (e) => console.error("[render]", e.message));
  // `path.resolve` (not a bare join): a relative `bundleDir` — e.g. `aida render -o dist/videos`
  // run from a project dir, rather than through build/pipeline.ts, which always resolves outDir
  // to an absolute path first — produced `file://dist/videos/...`, which Chromium rejects as an
  // invalid URL (no leading slash). Resolving against `process.cwd()` here matches what the
  // caller meant regardless of which path got us here.
  // `domcontentloaded`, not `load`: player.js may append a brand webfont stylesheet (fontUrl),
  // and an unreachable font host must not hold up (or time out) the whole render. player.js's
  // own `window.brandReady` waits for that font + the logo decode with a cap, so the first frame
  // is painted with the brand font when it's reachable and the system fallback when it isn't.
  await page.goto(`file://${path.resolve(bundleDir, "index.html")}?render=1`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() =>
    Promise.race([
      Promise.resolve((window as any).brandReady).then(() => (document as any).fonts.ready),
      new Promise((r) => setTimeout(r, 10_000)),
    ]),
  );
  return page;
}

async function withPage<T>(
  bundleDir: string,
  fn: (page: import("playwright").Page) => Promise<T>,
  deviceScaleFactor = 1,
): Promise<T> {
  const browser = await openBrowser();
  try {
    const page = await openPage(browser, bundleDir, deviceScaleFactor);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** Renders PNG stills at the given instants (seconds) into `<bundleDir>/stills/`. */
export async function renderStills(bundleDir: string, instants: number[]): Promise<string[]> {
  const outDir = path.join(bundleDir, "stills");
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  await withPage(bundleDir, async (page) => {
    for (const s of instants) {
      await page.evaluate((t) => (window as any).renderAt(t), s);
      const file = path.join(outDir, `t${s.toFixed(2)}.png`);
      await page.screenshot({ path: file });
      files.push(file);
    }
  });
  return files;
}

export interface RenderFramesResult {
  silentVideo: string;
  frames: number;
  wallTimeMs: number;
  /** Frames whose `frameSignature` matched the previous rendered frame's and so were repeated
   * from its screenshot bytes instead of paying another Chromium `page.evaluate`/`screenshot`
   * round trip (M16 part 2 — most of a walkthrough is a static screenshot held while narration
   * plays). Absent/0 when no `Timeline` was passed in (signature detection off). */
  framesSkipped?: number;
}

/** Steps `page` through `[start, end)` at `quality.fps`, writing one JPEG buffer per frame to
 * `onFrame`. When `timeline` is given, a frame whose `frameSignature` (state.ts) matches the
 * previous frame's is never screenshotted — the previous frame's buffer is reused instead, since
 * an identical signature means `renderAt` would have produced pixel-identical output anyway. */
async function stepFrames(
  page: import("playwright").Page,
  start: number,
  end: number,
  quality: RenderQuality,
  timeline: Timeline | undefined,
  onFrame: (buf: Buffer) => void | Promise<void>,
): Promise<{ framesSkipped: number }> {
  let lastSig: string | null = null;
  let lastBuf: Buffer | null = null;
  let framesSkipped = 0;
  for (let i = start; i < end; i++) {
    const t = i / quality.fps;
    const sig = timeline ? frameSignature(timeline, t) : null;
    if (sig !== null && sig === lastSig) {
      framesSkipped++;
      await onFrame(lastBuf!);
      continue;
    }
    await page.evaluate((t) => (window as any).renderAt(t), t);
    const buf = await page.screenshot({ type: "jpeg", quality: quality.screenshotQuality ?? 95 });
    lastSig = sig;
    lastBuf = buf;
    await onFrame(buf);
  }
  return { framesSkipped };
}

function spawnFrameEncoder(ffmpeg: string, quality: RenderQuality, frameCount: number, outFile: string) {
  return spawn(
    ffmpeg,
    [
      "-y",
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(quality.fps),
      "-c:v",
      "mjpeg",
      "-i",
      "-",
      // JPEG frames are full-range; convert to the limited-range BT.709 every player expects.
      "-vf",
      "scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      quality.preset,
      "-crf",
      String(quality.crf),
      "-r",
      String(quality.fps),
      // Closed GOP, one keyframe at frame 0 only: every segment can then be concatenated with
      // `-c copy` (segments.ts's concat demuxer) with no seam at the join. `-g` set to the
      // whole segment's frame count means x264 never needs another keyframe, and `-sc_threshold
      // 0` stops it inserting one on a scene cut.
      "-g",
      String(Math.max(1, frameCount)),
      "-sc_threshold",
      "0",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      outFile,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
}

/** `<dir>/<base>.tmp-<pid>-<random>.mp4` — ffmpeg writes here first so a crash or an early
 * browser close never leaves a truncated file sitting at the real output path, where
 * segments.ts's cache (`existsSync(target.file)`) would mistake it for a valid, reusable
 * segment. Keeps the `.mp4` suffix at the very end (rather than appending after it) because
 * ffmpeg picks its output muxer from the output filename's extension — `foo.mp4.tmp-123` has no
 * extension ffmpeg recognizes and fails to open. */
function tmpPathFor(outFile: string): string {
  const dir = path.dirname(outFile);
  const base = path.basename(outFile, ".mp4");
  return path.join(dir, `${base}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}.mp4`);
}

/** Ends an ffmpeg encoder's stdin, waits for it to exit (killing it if it doesn't on its own),
 * and deletes its (partial) output — used on the error path so a thrown `page.evaluate`/
 * screenshot never leaves the ffmpeg child process running with its stdin open (segments.ts's
 * concurrent workers would otherwise leak one ffmpeg process per failed scene) nor a partial
 * file behind. */
async function abortFrameEncoder(ff: ReturnType<typeof spawn>, ffDone: Promise<void>, tmpFile: string): Promise<void> {
  ff.stdin?.destroy();
  if (!ff.killed) ff.kill();
  await ffDone.catch(() => {});
  await rm(tmpFile, { force: true }).catch(() => {});
}

/** Steps renderAt through every frame of the full timeline, piping JPEG frames into FFmpeg. */
export async function renderFrames(
  bundleDir: string,
  timeline: Timeline,
  quality: RenderQuality,
  ffmpeg: string,
): Promise<RenderFramesResult> {
  const frames = Math.ceil(timeline.duration * quality.fps);
  const silent = path.join(bundleDir, "video.mp4");
  const tmpFile = tmpPathFor(silent);
  const ff = spawnFrameEncoder(ffmpeg, quality, frames, tmpFile);
  const ffDone = new Promise<void>((res, rej) => {
    ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
    ff.on("error", rej);
  });

  const started = Date.now();
  let framesSkipped = 0;
  try {
    await withPage(
      bundleDir,
      async (page) => {
        const result = await stepFrames(page, 0, frames, quality, timeline, async (buf) => {
          if (!ff.stdin!.write(buf)) await new Promise((r) => ff.stdin!.once("drain", r));
        });
        framesSkipped = result.framesSkipped;
        ff.stdin!.end();
      },
      quality.deviceScaleFactor,
    );
    await ffDone;
  } catch (err) {
    await abortFrameEncoder(ff, ffDone, tmpFile);
    throw err;
  }
  await rename(tmpFile, silent);

  return { silentVideo: silent, frames, wallTimeMs: Date.now() - started, framesSkipped };
}

export interface FrameRange {
  /** First global frame index (inclusive), where frame `i` is at time `i / quality.fps`. */
  start: number;
  /** Last global frame index (exclusive). */
  end: number;
}

/**
 * Renders one scene's frame range (segments.ts's per-scene cache unit) on an already-open
 * `page` — so N scenes can render concurrently on N pages of one shared browser (parallel frame
 * rendering) instead of each paying Playwright's page/browser startup cost.
 */
export async function renderFrameRange(
  page: import("playwright").Page,
  range: FrameRange,
  quality: RenderQuality,
  ffmpeg: string,
  outFile: string,
  timeline?: Timeline,
): Promise<RenderFramesResult> {
  const frames = range.end - range.start;
  // Write under a pid+random tmp name and rename into place only once ffmpeg exits clean —
  // segments.ts reuses a segment purely by `existsSync(outFile)`, so a half-written file must
  // never appear at `outFile` (a crash, or the browser closing mid-render, would otherwise leave
  // a truncated mp4 there that a later run would wrongly treat as a valid cached segment).
  const tmpFile = tmpPathFor(outFile);
  const ff = spawnFrameEncoder(ffmpeg, quality, frames, tmpFile);
  const ffDone = new Promise<void>((res, rej) => {
    ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
    ff.on("error", rej);
  });

  const started = Date.now();
  let framesSkipped = 0;
  try {
    const result = await stepFrames(page, range.start, range.end, quality, timeline, async (buf) => {
      if (!ff.stdin!.write(buf)) await new Promise((r) => ff.stdin!.once("drain", r));
    });
    framesSkipped = result.framesSkipped;
    ff.stdin!.end();
    await ffDone;
  } catch (err) {
    // page.evaluate/screenshot threw mid-loop: without this, ffmpeg's stdin is never ended (the
    // process leaks, still waiting for more frames) and `ffDone`'s rejection is never observed
    // (an unhandled rejection once ffmpeg eventually exits nonzero on its own).
    await abortFrameEncoder(ff, ffDone, tmpFile);
    throw err;
  }
  await rename(tmpFile, outFile);

  return { silentVideo: outFile, frames, wallTimeMs: Date.now() - started, framesSkipped };
}

/** Leftover `.tmp-*.mp4` files from a previous crashed/interrupted render — never valid
 * segments, always safe to delete. Swept before scanning `segmentsDir` for stale segments to
 * prune. */
export function isPartialSegmentFile(name: string): boolean {
  return /\.tmp-\d+-[a-z0-9]+\.mp4$/.test(name);
}

/** Opens one browser and hands out pages for parallel scene rendering; caller must `close()`. */
export async function openRenderBrowser(
  bundleDir: string,
  deviceScaleFactor: number,
  pageCount: number,
): Promise<{ pages: import("playwright").Page[]; close: () => Promise<void> }> {
  const browser = await openBrowser();
  try {
    const pages = await Promise.all(
      Array.from({ length: pageCount }, () => openPage(browser, bundleDir, deviceScaleFactor)),
    );
    return { pages, close: () => browser.close() };
  } catch (err) {
    // If any page fails to open (e.g. a bad bundleDir URL), `browser` was never handed back to
    // the caller for `close()` — without this it leaks: the CDP connection Playwright keeps open
    // to the still-running Chromium process holds the event loop open, so the whole `aida
    // render` process hangs forever instead of reporting the error and exiting (found while
    // profiling a cold draft render: a bad relative `bundleDir` left a zombie `node`/Chromium
    // pair running minutes after "render failed" had already been printed).
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Concatenates already-encoded segments (same codec params, closed GOP) with the ffmpeg
 * concat demuxer and `-c copy` — no re-encoding, so this is cheap regardless of video length. */
export async function concatSegments(segmentFiles: string[], outFile: string, ffmpeg: string): Promise<void> {
  const listFile = `${outFile}.concat.txt`;
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(listFile, segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  try {
    await execFileAsync(ffmpeg, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile]);
  } finally {
    await rm(listFile, { force: true });
  }
}

/** Muxes the silent video with the narration track, +faststart, titled from `title`. */
export async function muxVideo(silentVideo: string, narrationTrack: string, outFile: string, title: string, ffmpeg: string): Promise<void> {
  await execFileAsync(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-i",
    silentVideo,
    "-i",
    narrationTrack,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-shortest",
    "-movflags",
    "+faststart",
    "-metadata",
    `title=${title}`,
    outFile,
  ]);
}
