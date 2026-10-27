// Regression tests for the truncated-segment bug: a crash or the browser closing mid-render
// used to write straight to the final segment path, so a partial/truncated mp4 could be left at
// a path segments.ts's cache treats as valid (`existsSync(target.file)`) on the next run. Fixed
// by having `renderFrameRange` write to a `.tmp-<pid>-<rand>` path and rename into place only
// once ffmpeg exits clean, and by ending ffmpeg's stdin + killing it + deleting the partial file
// on any error (instead of leaking the process and leaving an unhandled `ffDone` rejection).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPartialSegmentFile, renderFrameRange } from "../../src/render/video.js";
import type { RenderQuality } from "../../src/render/types.js";

const execFileAsync = promisify(execFile);

let fixtureDir: string;
let jpegFrame: Buffer;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "aida-video-test-fixture-"));
  const framePath = path.join(fixtureDir, "frame.jpg");
  await execFileAsync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=1",
    "-frames:v",
    "1",
    framePath,
  ]);
  jpegFrame = readFileSync(framePath);
}, 30_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const quality: RenderQuality = { fps: 2, crf: 30, preset: "ultrafast", deviceScaleFactor: 1 };

/** Minimal Playwright `Page` stand-in: `renderFrameRange` only calls `.evaluate()` (to step
 * `renderAt(t)`) and `.screenshot()`. `failAfter` simulates the browser closing / a page crash
 * partway through — the Nth `evaluate()` call throws, as `page.evaluate` would once Playwright's
 * page or context is gone. */
function fakePage(failAfter?: number) {
  let calls = 0;
  return {
    evaluate: async () => {
      calls++;
      if (failAfter !== undefined && calls > failAfter) throw new Error("page crashed (simulated)");
    },
    screenshot: async () => jpegFrame,
  } as unknown as import("playwright").Page;
}

describe("renderFrameRange", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), "aida-video-test-out-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("renders to a tmp path and renames into place on success, leaving no tmp file behind", async () => {
    const outFile = path.join(outDir, "scene.mp4");
    const page = fakePage();

    const result = await renderFrameRange(page, { start: 0, end: 4 }, quality, "ffmpeg", outFile);

    expect(result.frames).toBe(4);
    expect(existsSync(outFile)).toBe(true);
    expect(readdirSync(outDir).filter(isPartialSegmentFile)).toEqual([]);
  }, 30_000);

  it("on a page failure mid-render, leaves no file at outFile and no leftover tmp file (segments.ts must never reuse a truncated segment)", async () => {
    const outFile = path.join(outDir, "scene.mp4");
    const page = fakePage(2); // throws from the 3rd frame on

    await expect(renderFrameRange(page, { start: 0, end: 6 }, quality, "ffmpeg", outFile)).rejects.toThrow(
      /page crashed/,
    );

    // The bug: ffmpeg wrote straight to `outFile`, so a crash left a truncated mp4 right there —
    // a later run's `existsSync(target.file)` check would wrongly treat it as a cached segment.
    expect(existsSync(outFile)).toBe(false);
    // The fix also cleans up its own `.tmp-*` file rather than leaving it to accumulate.
    expect(readdirSync(outDir).filter(isPartialSegmentFile)).toEqual([]);
  }, 30_000);

  it("does not hang or leave an unhandled rejection when the page fails before writing any frame", async () => {
    const outFile = path.join(outDir, "scene.mp4");
    const page = fakePage(0); // fails on the very first frame

    await expect(renderFrameRange(page, { start: 0, end: 3 }, quality, "ffmpeg", outFile)).rejects.toThrow();
    expect(existsSync(outFile)).toBe(false);
    expect(readdirSync(outDir).filter(isPartialSegmentFile)).toEqual([]);
  }, 30_000);
});

describe("isPartialSegmentFile", () => {
  it("matches tmp-write leftovers but not a real segment filename", () => {
    expect(isPartialSegmentFile("step-one-abc123.tmp-12345-x7y2z9.mp4")).toBe(true);
    expect(isPartialSegmentFile("step-one-abc123.mp4")).toBe(false);
  });
});
