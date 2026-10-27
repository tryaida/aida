// Frame stabilization for capture (docs/scope.md "Only rebuild what changed": "A screenshot
// that moved less than a set threshold is kept."). Playwright screenshots of the same walkthrough
// against the same reset app state are never byte-identical frame-for-frame (anti-aliasing/timing
// jitter), so without this, render's content hash always sees a "changed" frame and re-renders
// even when nothing a person would notice changed.
//
// The fix: after a capture run writes new frames, diff each one against the SAME-NAMED frame from
// the previous successful capture of that walkthrough. When the pixel difference is under a
// threshold, overwrite the new frame's bytes with the old frame's exact bytes, so render's content
// hash (render/hash.ts, sha256 of bytes) comes out identical to last run's. M10: render's hash no
// longer depends on mtime at all (it's a content hash; path+size+mtime is used only internally,
// as a cache key to avoid re-reading an unchanged file's bytes), so restorePrevFrame() below
// restoring the old mtime too is now a harmless bonus, not a correctness requirement — kept as
// the simplest way to make `kept` frames fully byte-and-metadata identical to last run's.
//
// M11 (docs/build-plan.md, "capture speed"): decoding ~185 2880x1620 PNGs twice each (new + prev)
// is the single biggest cost added since the 123s baseline. Two independent fixes, both behaviour-
// preserving (same kept/changed decision for every frame):
//   1. A byte-equality fast path (png-diff-core.ts `buffersEqual`) skips the decode entirely when
//      the two files are already identical bytes — free when it hits, and a decode-bound frame
//      never gets *mis*-classified by it (identical bytes are always a 0% diff).
//   2. Frame pairs are decoded+compared across a worker_thread pool (one decode pair is pure CPU
//      work with zero shared state, so this parallelises across cores for free) once there are
//      enough frames to be worth the pool's startup cost; small counts (tests, tiny walkthroughs)
//      stay on the single-threaded path below so unit tests don't pay worker spawn latency.
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { diffPngBuffers as diffPngBuffersCore, buffersEqual } from "./png-diff-core.mjs";
import { isProfiling, profileAsync, profileReport } from "./profile.js";

export interface FrameDiffResult {
  /** Fraction (0-1) of pixels that differ by more than `perChannelTolerance` on any channel. */
  changedFraction: number;
  /** False when the two images have different width/height — treated as fully changed. */
  dimensionsMatch: boolean;
}

/** Decodes two PNG buffers and compares them pixel-by-pixel with a per-channel tolerance. */
export function diffPngBuffers(a: Buffer, b: Buffer, perChannelTolerance: number): FrameDiffResult {
  return diffPngBuffersCore(a, b, perChannelTolerance) as FrameDiffResult;
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "frame-diff-worker.mjs");
/** Below this many pairs, the worker pool's spawn cost isn't worth it — diff synchronously. */
const MIN_FRAMES_FOR_POOL = 16;

interface DiffTask {
  file: string;
  newPath: string;
  prevPath: string;
}

/**
 * Diffs every task across a small pool of worker_threads (sized to the machine's cores, capped
 * to the task count). Falls back to the synchronous path for the whole batch if a worker fails to
 * start at all (e.g. a sandboxed/exotic runtime) — correctness never depends on the pool working.
 */
async function diffWithWorkerPool(
  tasks: DiffTask[],
  tolerance: number,
  workerPath: string = WORKER_PATH,
): Promise<Map<string, FrameDiffResult>> {
  const poolSize = Math.max(1, Math.min(availableParallelism(), tasks.length));
  const workers: Worker[] = [];
  try {
    for (let i = 0; i < poolSize; i++) workers.push(new Worker(workerPath));
  } catch {
    for (const w of workers) w.terminate();
    console.warn("frame-diff: worker pool unavailable, falling back to synchronous diffing");
    return diffSynchronously(tasks, tolerance);
  }

  const results = new Map<string, FrameDiffResult>();
  let nextTask = 0;
  let settled = 0;
  let poolFailed = false;

  await new Promise<void>((resolve) => {
    const finishIfDone = (): void => {
      settled++;
      if (settled === tasks.length) resolve();
    };
    const assignNext = (worker: Worker): void => {
      if (poolFailed) return;
      const idx = nextTask++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];
      worker.once("message", (msg: { id: string; changedFraction: number; dimensionsMatch: boolean }) => {
        results.set(msg.id, { changedFraction: msg.changedFraction, dimensionsMatch: msg.dimensionsMatch });
        finishIfDone();
        assignNext(worker);
      });
      worker.postMessage({ id: task.file, newPath: task.newPath, prevPath: task.prevPath, tolerance });
    };
    for (const worker of workers) {
      worker.on("error", () => {
        // One worker dying mid-pool: the remaining tasks it would have picked up still need an
        // answer, so fall back for whatever wasn't completed rather than hanging forever.
        poolFailed = true;
        resolve();
      });
      worker.on("exit", (code) => {
        // A worker can also go away *without* an "error" event (e.g. it's killed, or the module
        // it was supposed to run never loaded and the thread just stops) — treated the same as an
        // error, since otherwise `finishIfDone()` never fires for whatever task it was assigned
        // and the pool hangs forever. A clean `code === 0` exit only happens from our own
        // `terminate()` calls below, after the promise has already settled, so this is a no-op then.
        if (code !== 0) {
          poolFailed = true;
          resolve();
        }
      });
      assignNext(worker);
    }
    if (tasks.length === 0) resolve();
  });

  for (const w of workers) w.terminate();

  if (poolFailed || results.size < tasks.length) {
    console.warn("frame-diff: worker pool failed partway through, falling back to synchronous diffing for the rest");
    const remaining = tasks.filter((t) => !results.has(t.file));
    for (const [k, v] of diffSynchronously(remaining, tolerance).entries()) results.set(k, v);
  }

  return results;
}

function diffSynchronously(tasks: DiffTask[], tolerance: number): Map<string, FrameDiffResult> {
  const results = new Map<string, FrameDiffResult>();
  for (const task of tasks) {
    const newBuf = readFileSync(task.newPath);
    const prevBuf = readFileSync(task.prevPath);
    const diff = buffersEqual(newBuf, prevBuf)
      ? { changedFraction: 0, dimensionsMatch: true }
      : diffPngBuffers(newBuf, prevBuf, tolerance);
    results.set(task.file, diff);
  }
  return results;
}

export interface StabilizeOptions {
  /** Fraction of pixels (0-1) that may differ before a frame counts as changed. */
  threshold: number;
  /** Per-channel (0-255) tolerance before a pixel counts as differing at all. */
  tolerance: number;
  /** Test-only override for the worker script path, to exercise the pool-failure fallback. */
  workerPath?: string;
}

export interface StabilizeResult {
  /** Frames whose bytes+mtime were restored from the previous capture (unchanged, within tolerance). */
  kept: number;
  /** Frames with no previous counterpart, or whose diff was at/above threshold. */
  changed: number;
}

/**
 * Puts the previous frame's exact bytes AND exact mtime at `newPath`. A rename is used because
 * it keeps the original inode, so `mtimeMs` matches to the nanosecond; `utimesSync` can't
 * round-trip it (a `Date` truncates to whole ms, numeric seconds lose precision as a double),
 * and render/hash.ts fingerprints the full fractional `mtimeMs`. The previous frame is consumed
 * by the move — fine, since its `.prev` dir is deleted right after stabilization anyway. Falls
 * back to copy + utimes (best effort) if the rename fails, e.g. across filesystems.
 */
function restorePrevFrame(prevPath: string, newPath: string): void {
  try {
    renameSync(prevPath, newPath);
  } catch {
    const prevStat = statSync(prevPath);
    copyFileSync(prevPath, newPath);
    utimesSync(newPath, prevStat.atime, prevStat.mtime);
  }
}

/**
 * For every `.png` in `newFramesDir`, compares it against the same-named file in
 * `prevFramesDir` (when given). Frames within tolerance have their bytes and mtime/atime
 * replaced with the previous frame's exact values, so a later content-hash fingerprint
 * (path+size+mtime) sees no change — kept frames are moved out of `prevFramesDir` (see
 * `restorePrevFrame`). Frames with no previous counterpart count as "changed", not "kept".
 *
 * Async (was sync): pairs that need a real decode+compare run across a worker pool once there
 * are enough of them (see `MIN_FRAMES_FOR_POOL`) — see the M11 note at the top of this file.
 * `restorePrevFrame`'s renames still happen on the main thread after diffing, since it's cheap
 * filesystem bookkeeping, not CPU-bound decode work.
 */
export async function stabilizeFrames(
  newFramesDir: string,
  prevFramesDir: string | undefined,
  opts: StabilizeOptions,
): Promise<StabilizeResult> {
  let kept = 0;
  let changed = 0;
  if (!existsSync(newFramesDir)) return { kept, changed };

  const files = readdirSync(newFramesDir).filter((f) => f.toLowerCase().endsWith(".png"));
  const tasks: DiffTask[] = [];
  for (const file of files) {
    const newPath = join(newFramesDir, file);
    const prevPath = prevFramesDir ? join(prevFramesDir, file) : undefined;
    if (!prevPath || !existsSync(prevPath)) {
      changed++;
      continue;
    }
    tasks.push({ file, newPath, prevPath });
  }

  const diffs =
    tasks.length >= MIN_FRAMES_FOR_POOL
      ? await diffWithWorkerPool(tasks, opts.tolerance, opts.workerPath)
      : diffSynchronously(tasks, opts.tolerance);

  for (const task of tasks) {
    const diff = diffs.get(task.file) ?? { changedFraction: 1, dimensionsMatch: false };
    if (diff.dimensionsMatch && diff.changedFraction < opts.threshold) {
      restorePrevFrame(task.prevPath, task.newPath);
      kept++;
    } else {
      changed++;
    }
  }

  return { kept, changed };
}

/**
 * Renames `<outDir>/frames` out of the way (to `frames.prev`) so `runCapture()` can recreate
 * `frames/` fresh, as it does today, while still leaving the previous run's frames around to
 * diff against. Returns the `.prev` dir's path, or `undefined` when there was no previous
 * `frames/` to snapshot (first capture).
 *
 * Any stale `.prev` left behind by a previously-failed run is removed first, so a failed
 * capture never wedges the next run — it just loses one generation of diff history.
 */
export function snapshotPrevFrames(outDir: string): string | undefined {
  const framesDir = join(outDir, "frames");
  const prevDir = `${framesDir}.prev`;
  rmSync(prevDir, { recursive: true, force: true });
  if (!existsSync(framesDir)) return undefined;
  renameSync(framesDir, prevDir);
  return prevDir;
}

/** After a capture that threw: drops the half-written `frames/` and moves `prevDir` back to it. */
export function restorePrevFramesAfterFailure(outDir: string, prevDir: string | undefined): void {
  const framesDir = join(outDir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  if (prevDir && existsSync(prevDir)) renameSync(prevDir, framesDir);
}

/** Stabilizes `<outDir>/frames` against `prevDir` (from `snapshotPrevFrames`), then removes `prevDir`. */
export async function finishStabilization(
  outDir: string,
  prevDir: string | undefined,
  opts: StabilizeOptions,
): Promise<StabilizeResult> {
  const framesDir = join(outDir, "frames");
  const result = await profileAsync("frame-diff", () => stabilizeFrames(framesDir, prevDir, opts));
  if (prevDir) rmSync(prevDir, { recursive: true, force: true });
  return result;
}

/**
 * Wraps a capture run with frame stabilization: snapshots the previous `frames/` dir out of the
 * way, runs `run()` (which recreates `frames/` fresh, as `runCapture()` does), then diffs new
 * frames against the previous ones and restores bytes+mtime for any that are effectively
 * unchanged. When `run()` throws, the half-written `frames/` is removed and the previous one is
 * moved back (when there was one), so the dir still holds the last capture that finished and
 * nothing reads half-written frames; the error is then rethrown.
 *
 * Shared by both `aida capture` (commands/capture.ts) and the build pipeline's capture stage
 * (build/pipeline.ts), which both write to `<outDir>/frames` in place — so this logic must stay
 * in exactly one place to keep them in sync.
 *
 * This is also the one place both call paths share after `run()` (= `runCapture()`, which resets
 * and records the navigation/settle/masking/screenshot phases — see runner.ts), so it's where
 * the combined `AIDA_PROFILE=1` report gets printed, covering every M11 phase in one line each.
 */
export async function withFrameStabilization<T>(
  outDir: string,
  opts: StabilizeOptions,
  run: () => Promise<T>,
): Promise<{ result: T; frameDiff: StabilizeResult }> {
  const wallStart = Date.now();
  const prevDir = snapshotPrevFrames(outDir);
  let result: T;
  try {
    result = await run();
  } catch (err) {
    restorePrevFramesAfterFailure(outDir, prevDir);
    throw err;
  }
  const frameDiff = await finishStabilization(outDir, prevDir, opts);
  if (isProfiling()) {
    const report = profileReport(Date.now() - wallStart);
    if (report) console.log(report);
  }
  return { result, frameDiff };
}
