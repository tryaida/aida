// Progress for the demo's build. The build pipeline prints nothing until it's done, and a first
// run takes a couple of minutes, so the demo watches for each output file to be written (newer
// than the build's start) and prints a line as each one appears, plus a "still working" line when
// nothing new has appeared for a while. Read-only: it never touches the files it watches.
// Narration blocks the event loop, so the watcher's timer can't fire while it runs; the
// pipeline's synchronous `onProgress` hook (`stageProgress`) says which walkthrough is being
// narrated as each one starts.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { BuildProgressEvent } from "../build/index.js";

export type ProgressStage = "capture" | "voice" | "render" | "pages" | "pdf";

export interface WatchedOutput {
  stage: ProgressStage;
  walkthrough: string;
  file: string;
}

const DONE_WORDS: Record<ProgressStage, string> = {
  capture: "captured",
  voice: "narrated",
  render: "rendered the video for",
  pages: "built the page for",
  pdf: "made the PDF guide for",
};

const BUSY_WORDS: Record<ProgressStage, string> = {
  capture: "capturing in the browser",
  voice: "narrating",
  render: "rendering videos",
  pages: "building pages",
  pdf: "making PDFs",
};

/** The files each stage writes for each walkthrough, in the order the pipeline writes them. */
export function outputsToWatch(
  paths: { buildDir: string; outDir: string },
  walkthroughs: string[],
  opts: { video: boolean },
): WatchedOutput[] {
  const out: WatchedOutput[] = [];
  for (const id of walkthroughs) {
    out.push({ stage: "capture", walkthrough: id, file: join(paths.buildDir, id, "capture", "validation.json") });
    if (opts.video) out.push({ stage: "voice", walkthrough: id, file: join(paths.buildDir, id, "voice", "manifest.json") });
  }
  const later: ProgressStage[] = opts.video ? ["render", "pages", "pdf"] : ["pages", "pdf"];
  for (const stage of later) {
    for (const id of walkthroughs) {
      const file =
        stage === "render"
          ? join(paths.outDir, "videos", id, `${id}.mp4`)
          : stage === "pages"
            ? join(paths.outDir, "pages", id, "index.mdx")
            : join(paths.outDir, "pdf", `${id}.pdf`);
      out.push({ stage, walkthrough: id, file });
    }
  }
  return out;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function modifiedSince(file: string, since: number): boolean {
  try {
    // A second's slack: some filesystems keep mtimes to the second.
    return statSync(file).mtimeMs >= since - 1000;
  } catch {
    return false;
  }
}

export interface ProgressWatcher {
  /** Checks once more (so the last outputs are reported) and stops. */
  stop(): void;
  /** Something else just printed progress: restart the "still working" clock. */
  heard(): void;
}

/**
 * Polls `outputs` every `intervalMs` and calls `log` with a line for each one written since
 * `since`, and a "still working" line after `quietMs` without one (then every `quietMs`).
 */
export function watchProgress(
  outputs: WatchedOutput[],
  log: (line: string) => void,
  opts: { since?: number; intervalMs?: number; quietMs?: number; now?: () => number } = {},
): ProgressWatcher {
  const now = opts.now ?? Date.now;
  const since = opts.since ?? now();
  const quietMs = opts.quietMs ?? 20_000;
  const seen = new Set<WatchedOutput>();
  const totals = new Map<ProgressStage, number>();
  for (const o of outputs) totals.set(o.stage, (totals.get(o.stage) ?? 0) + 1);
  const done = new Map<ProgressStage, number>();
  let lastNews = now();

  const check = (final = false): void => {
    for (const o of outputs) {
      if (seen.has(o) || !modifiedSince(o.file, since)) continue;
      seen.add(o);
      const n = (done.get(o.stage) ?? 0) + 1;
      done.set(o.stage, n);
      lastNews = now();
      log(`  ${formatElapsed(now() - since)}  ${DONE_WORDS[o.stage]} ${o.walkthrough} (${n} of ${totals.get(o.stage)})`);
    }
    if (!final && now() - lastNews >= quietMs) {
      // Unchanged outputs (a cached voice or video) are never rewritten, so this is a guess:
      // the first stage with outputs still to come.
      const pending = outputs.find((o) => !seen.has(o));
      log(`  ${formatElapsed(now() - since)}  still working: ${pending ? BUSY_WORDS[pending.stage] : "checking the outputs, the full manual and the search index"}`);
      lastNews = now();
    }
  };
  const timer = setInterval(() => check(), opts.intervalMs ?? 1000);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      check(true);
    },
    heard() {
      lastNews = now();
    },
  };
}

/**
 * A `BuildOptions.onProgress` callback for the demo: a "Narrating <title> (n of N)..." line as
 * each walkthrough's narration starts (the one stage that blocks the event loop, so the file
 * watcher is silent through it), and `heard()` on every event so the watcher's "still working"
 * line doesn't fire straight after a long stage it already knew about.
 */
export function stageProgress(
  log: (line: string) => void,
  opts: { since: number; narrations: number; heard?: () => void; now?: () => number },
): (e: BuildProgressEvent) => void {
  const now = opts.now ?? Date.now;
  let narrated = 0;
  return (e) => {
    opts.heard?.();
    if (e.stage !== "voice" || e.phase !== "start") return;
    narrated += 1;
    const total = Math.max(opts.narrations, narrated);
    log(`  ${formatElapsed(now() - opts.since)}  Narrating ${e.title ?? e.walkthrough} (${narrated} of ${total})...`);
  };
}
