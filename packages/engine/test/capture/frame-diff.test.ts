import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { statSync, utimesSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffPngBuffers, stabilizeFrames, withFrameStabilization } from "../../src/capture/frame-diff.js";

const here = dirname(fileURLToPath(import.meta.url));
const BROKEN_WORKER_PATH = pathJoin(here, "fixture", "broken-worker.mjs");
import { computeContentHash, matchesCachedHash, writeHashSidecar } from "../../src/render/hash.js";
import type { Timeline } from "../../src/render/types.js";

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const [r, g, b, a] = fill(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const SOLID_BLUE = makePng(10, 10, () => [10, 20, 200, 255]);

describe("diffPngBuffers", () => {
  it("is 0 for identical buffers", () => {
    const result = diffPngBuffers(SOLID_BLUE, SOLID_BLUE, 8);
    expect(result.dimensionsMatch).toBe(true);
    expect(result.changedFraction).toBe(0);
  });

  it("treats a single pixel changed by a tiny amount as within tolerance", () => {
    const tweaked = makePng(10, 10, (x, y) => (x === 0 && y === 0 ? [13, 23, 203, 255] : [10, 20, 200, 255]));
    const result = diffPngBuffers(SOLID_BLUE, tweaked, 8);
    expect(result.dimensionsMatch).toBe(true);
    expect(result.changedFraction).toBe(0);
    expect(result.changedFraction).toBeLessThan(0.001);
  });

  it("counts a few pixels changed by a large amount as changed, above a tight threshold", () => {
    const changed = makePng(10, 10, (x, y) => (y === 0 && x < 3 ? [250, 250, 10, 255] : [10, 20, 200, 255]));
    const result = diffPngBuffers(SOLID_BLUE, changed, 8);
    expect(result.dimensionsMatch).toBe(true);
    // 3 of 100 pixels changed.
    expect(result.changedFraction).toBeCloseTo(0.03, 5);
    expect(result.changedFraction).toBeGreaterThan(0.001);
  });

  it("reports dimension mismatches as changed, without crashing", () => {
    const other = makePng(5, 5, () => [10, 20, 200, 255]);
    const result = diffPngBuffers(SOLID_BLUE, other, 8);
    expect(result.dimensionsMatch).toBe(false);
    expect(result.changedFraction).toBe(1);
  });
});

function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "aida-frame-diff-"));
}

describe("stabilizeFrames", () => {
  let prevDir: string;
  let newDir: string;

  beforeEach(async () => {
    prevDir = await tmpDir();
    newDir = await tmpDir();
  });

  afterEach(async () => {
    await rm(prevDir, { recursive: true, force: true });
    await rm(newDir, { recursive: true, force: true });
  });

  it("keeps near-identical frames (restoring old bytes+mtime), replaces changed ones, and counts new-only frames as changed", async () => {
    const stableOld = makePng(4, 4, () => [1, 2, 3, 255]);
    // Near-identical: one pixel nudged by 1, well within tolerance.
    const stableNew = makePng(4, 4, (x, y) => (x === 0 && y === 0 ? [2, 3, 4, 255] : [1, 2, 3, 255]));
    const differentOld = makePng(4, 4, () => [0, 0, 0, 255]);
    const differentNew = makePng(4, 4, () => [255, 255, 255, 255]);

    await writeFile(path.join(prevDir, "0001-stable.png"), stableOld);
    await writeFile(path.join(newDir, "0001-stable.png"), stableNew);
    await writeFile(path.join(prevDir, "0002-changed.png"), differentOld);
    await writeFile(path.join(newDir, "0002-changed.png"), differentNew);
    await writeFile(path.join(newDir, "0003-new.png"), makePng(4, 4, () => [9, 9, 9, 255]));

    // Give the "old" frame a distinctly old mtime so we can tell it was actually restored.
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(prevDir, "0001-stable.png"), oldTime, oldTime);
    const oldStableStat = statSync(path.join(prevDir, "0001-stable.png"));
    const oldStableBytes = await import("node:fs/promises").then((fs) => fs.readFile(path.join(prevDir, "0001-stable.png")));

    const result = await stabilizeFrames(newDir, prevDir, { threshold: 0.001, tolerance: 8 });

    expect(result).toEqual({ kept: 1, changed: 2 });

    const keptBytes = await import("node:fs/promises").then((fs) => fs.readFile(path.join(newDir, "0001-stable.png")));
    expect(keptBytes.equals(oldStableBytes)).toBe(true);
    const keptStat = statSync(path.join(newDir, "0001-stable.png"));
    expect(keptStat.mtimeMs).toBe(oldStableStat.mtimeMs);

    const changedBytes = await import("node:fs/promises").then((fs) => fs.readFile(path.join(newDir, "0002-changed.png")));
    expect(changedBytes.equals(differentNew)).toBe(true);
  });

  it("counts every frame as changed when there is no previous frames dir", async () => {
    await writeFile(path.join(newDir, "0001-a.png"), makePng(2, 2, () => [1, 1, 1, 255]));
    await writeFile(path.join(newDir, "0002-b.png"), makePng(2, 2, () => [2, 2, 2, 255]));
    const result = await stabilizeFrames(newDir, undefined, { threshold: 0.001, tolerance: 8 });
    expect(result).toEqual({ kept: 0, changed: 2 });
  });

  it("takes the byte-identical fast path (no decode needed) for frames that are exact copies", async () => {
    const bytes = makePng(4, 4, () => [7, 8, 9, 255]);
    await writeFile(path.join(prevDir, "0001-same.png"), bytes);
    await writeFile(path.join(newDir, "0001-same.png"), bytes);

    const result = await stabilizeFrames(newDir, prevDir, { threshold: 0.001, tolerance: 0 });
    expect(result).toEqual({ kept: 1, changed: 0 });
  });

  it("gives the same kept/changed counts through the worker pool as the single-threaded path", async () => {
    // Above MIN_FRAMES_FOR_POOL (16) so this exercises diffWithWorkerPool, not diffSynchronously.
    const stable = makePng(4, 4, () => [1, 2, 3, 255]);
    const changed = makePng(4, 4, () => [255, 0, 0, 255]);
    for (let i = 0; i < 20; i++) {
      const name = `${String(i).padStart(4, "0")}-frame.png`;
      await writeFile(path.join(prevDir, name), stable);
      // Every 5th frame actually changes; the rest are identical bytes.
      await writeFile(path.join(newDir, name), i % 5 === 0 ? changed : stable);
    }

    const result = await stabilizeFrames(newDir, prevDir, { threshold: 0.001, tolerance: 8 });
    expect(result).toEqual({ kept: 16, changed: 4 });
  });

  it(
    "falls back to the synchronous diff (instead of hanging) when every pool worker exits on its own " +
      "without ever erroring or responding (bug: no 'exit' handler, so a dead-on-arrival worker script " +
      "— e.g. a missing dist asset — left the pool's promise unresolved forever)",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const stable = makePng(4, 4, () => [1, 2, 3, 255]);
        const changed = makePng(4, 4, () => [255, 0, 0, 255]);
        for (let i = 0; i < 20; i++) {
          const name = `${String(i).padStart(4, "0")}-frame.png`;
          await writeFile(path.join(prevDir, name), stable);
          await writeFile(path.join(newDir, name), i % 5 === 0 ? changed : stable);
        }

        const result = await stabilizeFrames(newDir, prevDir, {
          threshold: 0.001,
          tolerance: 8,
          workerPath: BROKEN_WORKER_PATH,
        });

        // Same correct answer as the healthy-pool test above — the synchronous fallback must be
        // behaviour-identical, not just "doesn't hang".
        expect(result).toEqual({ kept: 16, changed: 4 });
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
    15_000,
  );
});

describe("withFrameStabilization + render content hash (proves the render-skip)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await tmpDir();
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function minimalTimeline(framePaths: string[]): Timeline {
    return {
      fps: 30,
      viewport: { w: 10, h: 10 },
      stage: { x: 0, y: 0, w: 10, h: 10 },
      fade: 0.35,
      brand: { name: "Demo" },
      intro: { eyebrow: "", titleHtml: "Demo", subtitle: "" },
      outro: { title: "", recap: [] },
      chapters: [],
      frames: framePaths.map((src, i) => ({ t: i, src, transition: "cut" as const })),
      moves: [],
      clicks: [],
      highlights: [],
      cameras: [],
      captions: [],
      chips: [],
      audio: [],
      cursorStart: { x: 0, y: 0 },
      stageIn: { t0: 0, t1: 1 },
      stageOut: { t0: 1, t1: 2 },
      duration: 2,
      previewAudio: "narration.m4a",
    };
  }

  const settings = { fps: 30, crf: 17, preset: "slow", draft: false };

  it("recapturing near-identical frames with fresh mtimes still matches the previously-cached render hash", async () => {
    const framesDir = path.join(outDir, "frames");
    await mkdir(framesDir, { recursive: true });

    const frameA = makePng(6, 6, () => [50, 60, 70, 255]);
    const framePath = path.join(framesDir, "0001-frame.png");
    await writeFile(framePath, frameA);

    const timeline = minimalTimeline([framePath]);
    const hash1 = computeContentHash(timeline, [framePath], settings);
    const mp4 = path.join(outDir, "demo.mp4");
    await writeFile(mp4, "fake-mp4-bytes");
    writeHashSidecar(mp4, hash1);

    // Simulate a recapture: snapshot old frames/, write pixel-near-identical frames with fresh
    // mtimes (as a real recapture would — new Playwright screenshots), then stabilize.
    const { frameDiff } = await withFrameStabilization(outDir, { threshold: 0.001, tolerance: 8 }, async () => {
      await rm(framesDir, { recursive: true, force: true });
      await mkdir(framesDir, { recursive: true });
      const nearIdentical = makePng(6, 6, (x, y) => (x === 0 && y === 0 ? [51, 61, 71, 255] : [50, 60, 70, 255]));
      await writeFile(framePath, nearIdentical);
      return undefined;
    });

    expect(frameDiff).toEqual({ kept: 1, changed: 0 });

    const hash2 = computeContentHash(timeline, [framePath], settings);
    expect(hash2).toBe(hash1);
    expect(matchesCachedHash(mp4, hash2)).toBe(true);
  });
});

describe("withFrameStabilization when the capture throws", () => {
  it("drops the half-written frames and moves the previous ones back", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "aida-frames-throw-"));
    try {
      await mkdir(pathJoin(outDir, "frames"));
      await writeFile(pathJoin(outDir, "frames", "0001-old.png"), "old");
      await expect(
        withFrameStabilization(outDir, { threshold: 0.001, tolerance: 8 }, async () => {
          await mkdir(pathJoin(outDir, "frames"));
          await writeFile(pathJoin(outDir, "frames", "0001-half.png"), "half");
          throw new Error("browser crashed");
        }),
      ).rejects.toThrow("browser crashed");
      const { readdirSync, existsSync } = await import("node:fs");
      expect(readdirSync(pathJoin(outDir, "frames"))).toEqual(["0001-old.png"]);
      expect(existsSync(pathJoin(outDir, "frames.prev"))).toBe(false);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
