// Runs ffmpeg and ffprobe so that every run ends. Node built-ins only: the help app's lean runtime
// build reaches render/ and qa/ (test/package/runtime-imports.test.ts).
//
// - No stdin: it's ignored, and ffmpeg gets `-nostdin`, so a run never waits on a terminal.
// - A time limit and an optional AbortSignal, both ending the run with SIGKILL. Not SIGTERM: on
//   SIGTERM ffmpeg drains its filter graph first, so a graph that never reaches its end ignores it
//   (hung narration mixes once ran for hours at full CPU).
// - Runs still going when this process exits are killed with it (a test worker that gave up).
//
// Time limits scale with the media's length (`mediaTimeoutMs`): a fixed base for start-up and a
// busy machine, plus a per-second allowance well above what any step needs. Stream copies and the
// narration mix take seconds for minutes of video; the slowest step timed here, a full decode for
// QA's loudness and black-frame checks, runs many times faster than real time. 2 s per second of
// media allows half real time even on a loaded machine, so a long guide's real render is never
// cut off; only a run that has stopped making progress is.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Fixed part of every media time limit: start-up, a cold disk, a busy machine. */
export const MEDIA_TIMEOUT_BASE_MS = 120_000;
/** Allowance per second of media. */
export const MEDIA_TIMEOUT_PER_SECOND_MS = 2_000;
/** Limit for a run whose work doesn't grow with the media (`-version`, a tiny generated clip). */
export const SHORT_TOOL_TIMEOUT_MS = 60_000;
/** Limit for one ffprobe of a file's header (`-show_format`/`-show_streams`, no decoding). */
export const PROBE_TIMEOUT_MS = 60_000;
/** How long an encoder fed on stdin gets to exit after SIGTERM before it's SIGKILLed. */
export const KILL_GRACE_MS = 5_000;

/** Time limit for an ffmpeg run over `durationSeconds` of media (see the top of this file). */
export function mediaTimeoutMs(durationSeconds: number | undefined): number {
  const seconds = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0 ? Math.ceil(durationSeconds as number) : 0;
  return MEDIA_TIMEOUT_BASE_MS + seconds * MEDIA_TIMEOUT_PER_SECOND_MS;
}

export interface MediaToolOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Keep all of stderr (an ffmpeg analysis filter's report) instead of its last 4000 characters. */
  fullStderr?: boolean;
}

export interface MediaToolRun {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Media tools still running, killed if this process exits first. */
const liveTools = new Set<ChildProcess>();
let exitHook = false;

/** Tracks `child` until it exits, killing it with this process if that comes first. */
export function trackMediaProcess(child: ChildProcess): void {
  liveTools.add(child);
  child.once("exit", () => liveTools.delete(child));
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const c of liveTools) c.kill("SIGKILL");
    });
  }
}

function isFfmpeg(tool: string): boolean {
  return /ffmpeg(\.exe)?$/i.test(path.basename(tool));
}

/**
 * Runs ffmpeg or ffprobe and resolves with its output and exit status, whatever the status.
 * Rejects only when it can't start, times out or `signal` aborts (it's SIGKILLed then).
 */
export function spawnMediaTool(tool: string, args: string[], opts: MediaToolOptions): Promise<MediaToolRun> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error(`${path.basename(tool)} not started: ${String(opts.signal.reason ?? "aborted")}`));
    const child = spawn(tool, isFfmpeg(tool) ? ["-nostdin", ...args] : args, { stdio: ["ignore", "pipe", "pipe"] });
    trackMediaProcess(child);
    let stdout = "";
    let stderr = "";
    let why: string | undefined;
    const kill = (reason: string) => {
      why ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`), opts.timeoutMs);
    const onAbort = () => kill(`stopped: ${String(opts.signal?.reason ?? "aborted")}`);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr = opts.fullStderr ? stderr + d : (stderr + d).slice(-4000);
    });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (err) => {
      done();
      reject(err);
    });
    child.once("close", (code, signal) => {
      done();
      if (why) return reject(new Error(`${path.basename(tool)} failed: ${why}`));
      resolve({ stdout, stderr, code, signal });
    });
  });
}

/**
 * Runs ffmpeg or ffprobe and resolves with its stdout; rejects on a non-zero exit (with the end
 * of its stderr), a time-out or `signal` aborting. See the top of this file.
 */
export async function runMediaTool(tool: string, args: string[], opts: MediaToolOptions): Promise<string> {
  const run = await spawnMediaTool(tool, args, opts);
  if (run.code === 0) return run.stdout;
  const detail = run.stderr.trim().split("\n").slice(-3).join(" / ") || `exit ${run.code ?? run.signal}`;
  throw new Error(`${path.basename(tool)} failed: ${detail}`);
}

/**
 * Stops a process fed on stdin (the frame encoder): SIGTERM, then SIGKILL if it hasn't exited
 * after `graceMs`. Resolves once it has exited.
 */
export function stopProcess(child: ChildProcess, graceMs: number = KILL_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
