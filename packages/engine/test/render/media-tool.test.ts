// Every ffmpeg/ffprobe run ends (render/media-tool.ts): no stdin, SIGKILL on a time limit or an
// abort, and the frame encoder's error path escalates SIGTERM to SIGKILL. Stand-in tools that
// ignore SIGTERM and never exit, like the hung ffmpeg runs these guard against.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mediaTimeoutMs, MEDIA_TIMEOUT_BASE_MS, runMediaTool, spawnMediaTool } from "../../src/render/media-tool.js";
import { abortFrameEncoder, concatSegments, muxVideo } from "../../src/render/video.js";
import { buildNarrationTrack } from "../../src/render/audio.js";
import { runFfmpegReport, runFfprobe } from "../../src/qa/ffmpeg.js";
import type { Timeline } from "../../src/render/types.js";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "media-tool-test-"));
  dirs.push(d);
  return d;
}

/** A stand-in tool named `name` that records its pid, arguments and stdin, ignores SIGTERM and
 * never ends. */
function stuckTool(name = "ffmpeg"): { tool: string; record: string } {
  const dir = tmp();
  const record = join(dir, "record.json");
  const tool = join(dir, name);
  writeFileSync(
    tool,
    `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
try { stdin = fs.readlinkSync("/proc/self/fd/0"); } catch {}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), stdin }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(tool, 0o755);
  return { tool, record };
}

/** A stand-in tool that writes `stderr` and exits with `code`. */
function reportingTool(name: string, stderr: string, code: number): string {
  const dir = tmp();
  const tool = join(dir, name);
  writeFileSync(tool, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode = ${code};\n`);
  chmodSync(tool, 0o755);
  return tool;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function started(record: string): Promise<{ pid: number; args: string[]; stdin: string }> {
  for (let i = 0; i < 200 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 25));
  const seen = JSON.parse(readFileSync(record, "utf8")) as { pid: number; args: string[]; stdin: string };
  pids.push(seen.pid);
  return seen;
}

/** Starts `run`, waits for the stuck tool to be up, aborts, and checks the run ended and the
 * process is gone, with no stdin. */
async function abortsCleanly(record: string, stop: AbortController, run: Promise<unknown>): Promise<void> {
  const seen = await started(record);
  stop.abort("the caller gave up");
  await expect(run).rejects.toThrow(/the caller gave up/);
  expect(seen.args[0]).toBe("-nostdin");
  if (process.platform === "linux") expect(seen.stdin).toBe("/dev/null");
  for (let i = 0; i < 40 && alive(seen.pid); i++) await new Promise((r) => setTimeout(r, 25));
  expect(alive(seen.pid)).toBe(false);
}

describe("media time limits", () => {
  it("scale with the media's length from a fixed base", () => {
    expect(mediaTimeoutMs(0)).toBe(MEDIA_TIMEOUT_BASE_MS);
    expect(mediaTimeoutMs(undefined)).toBe(MEDIA_TIMEOUT_BASE_MS);
    expect(mediaTimeoutMs(Number.NaN)).toBe(MEDIA_TIMEOUT_BASE_MS);
    // A 20-minute guide gets the base plus 40 minutes: half real time on a loaded machine.
    expect(mediaTimeoutMs(1200)).toBe(MEDIA_TIMEOUT_BASE_MS + 2_400_000);
    expect(mediaTimeoutMs(10.2)).toBe(MEDIA_TIMEOUT_BASE_MS + 22_000);
  });
});

describe("spawnMediaTool / runMediaTool", () => {
  it("kills a run that ignores SIGTERM once its time is up", async () => {
    const { tool, record } = stuckTool();
    const t0 = Date.now();
    await expect(runMediaTool(tool, ["-y", "out.mp4"], { timeoutMs: 3000 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const seen = await started(record);
    expect(alive(seen.pid)).toBe(false);
  }, 20_000);

  it("returns stderr and the exit status whatever the status; runMediaTool rejects a failure with its stderr", async () => {
    const tool = reportingTool("ffmpeg", "line 1\nSummary: I: -16.0 LUFS\n", 1);
    const run = await spawnMediaTool(tool, [], { timeoutMs: 20_000, fullStderr: true });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Summary: I: -16.0 LUFS");
    await expect(runMediaTool(tool, [], { timeoutMs: 20_000 })).rejects.toThrow(/ffmpeg failed: line 1 \/ Summary/);
  }, 20_000);

  it("doesn't start when the signal has already aborted", async () => {
    const { tool, record } = stuckTool();
    const stop = new AbortController();
    stop.abort("too late");
    await expect(runMediaTool(tool, [], { timeoutMs: 20_000, signal: stop.signal })).rejects.toThrow(/not started: too late/);
    expect(existsSync(record)).toBe(false);
  });
});

describe("render's ffmpeg runs", () => {
  it("concatSegments: no stdin, killed when its caller gives up", async () => {
    const { tool, record } = stuckTool();
    const out = join(tmp(), "video.mp4");
    const stop = new AbortController();
    await abortsCleanly(record, stop, concatSegments(["/x/a.mp4"], out, tool, { durationSec: 10, signal: stop.signal }));
    expect(existsSync(`${out}.concat.txt`)).toBe(false);
  }, 20_000);

  it("muxVideo: no stdin, killed when its caller gives up", async () => {
    const { tool, record } = stuckTool();
    const stop = new AbortController();
    await abortsCleanly(record, stop, muxVideo("/x/silent.mp4", "/x/narration.m4a", join(tmp(), "out.mp4"), "T", tool, { durationSec: 10, signal: stop.signal }));
  }, 20_000);

  it("buildNarrationTrack: no stdin, killed when its caller gives up", async () => {
    const { tool, record } = stuckTool();
    const stop = new AbortController();
    const tl = { duration: 5, audio: [], clicks: [] } as unknown as Timeline;
    await abortsCleanly(record, stop, buildNarrationTrack(tl, tmp(), tool, { signal: stop.signal }));
  }, 20_000);

  it("abortFrameEncoder: escalates to SIGKILL when the encoder ignores SIGTERM", async () => {
    const { tool, record } = stuckTool();
    const dir = tmp();
    const tmpFile = join(dir, "seg.tmp-1-abc.mp4");
    writeFileSync(tmpFile, "partial");
    // As spawnFrameEncoder starts it: frames on stdin.
    const ff = spawn(tool, ["-i", "-", tmpFile], { stdio: ["pipe", "ignore", "ignore"] });
    const ffDone = new Promise<void>((res, rej) => {
      ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
      ff.on("error", rej);
    });
    const seen = await started(record);
    const t0 = Date.now();
    await abortFrameEncoder(ff, ffDone, tmpFile, 300);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(alive(seen.pid)).toBe(false);
    expect(ff.signalCode).toBe("SIGKILL");
    expect(existsSync(tmpFile)).toBe(false);
  }, 20_000);
});

describe("QA's ffmpeg runs", () => {
  it("runFfmpegReport: returns the report from a non-zero exit, and kills a hung run", async () => {
    const reporter = reportingTool("ffmpeg", "black_start:0 black_end:1.5\n", 1);
    expect(await runFfmpegReport(reporter, ["-i", "x.mp4"], { durationSec: 3 })).toContain("black_start:0");
    const { tool, record } = stuckTool();
    await expect(runFfmpegReport(tool, ["-i", "x.mp4"], { timeoutMs: 3000 })).rejects.toThrow(/timed out/);
    const seen = await started(record);
    expect(seen.args[0]).toBe("-nostdin");
    expect(alive(seen.pid)).toBe(false);
  }, 20_000);

  it("runFfprobe: killed when its time is up, with no stdin", async () => {
    const { tool, record } = stuckTool("ffprobe");
    await expect(runFfprobe(tool, ["-v", "error", "x.mp4"], { timeoutMs: 3000 })).rejects.toThrow(/timed out/);
    const seen = await started(record);
    if (process.platform === "linux") expect(seen.stdin).toBe("/dev/null");
    expect(seen.args[0]).toBe("-v");
    expect(alive(seen.pid)).toBe(false);
  }, 20_000);
});
