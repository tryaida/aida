import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeContentHash, hashSidecarPath, matchesCachedHash, writeHashSidecar } from "../../src/render/hash.js";
import type { Timeline } from "../../src/render/types.js";

function minimalTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    fps: 30,
    viewport: { w: 100, h: 100 },
    stage: { x: 0, y: 0, w: 100, h: 100 },
    fade: 0.35,
    brand: { name: "Demo" },
    intro: { eyebrow: "", titleHtml: "Demo", subtitle: "" },
    outro: { title: "", recap: [] },
    chapters: [],
    frames: [],
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
    ...overrides,
  };
}

const settings = { fps: 30, crf: 17, preset: "slow", draft: false };

describe("computeContentHash", () => {
  let dir: string;
  let fileA: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-hash-"));
    fileA = path.join(dir, "frame.jpg");
    await writeFile(fileA, "frame-1");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is stable for the same timeline, files and settings", () => {
    const a = computeContentHash(minimalTimeline(), [fileA], settings);
    const b = computeContentHash(minimalTimeline(), [fileA], settings);
    expect(a).toBe(b);
  });

  it("changes when the timeline changes", () => {
    const a = computeContentHash(minimalTimeline(), [fileA], settings);
    const b = computeContentHash(minimalTimeline({ duration: 3 }), [fileA], settings);
    expect(a).not.toBe(b);
  });

  it("changes when a referenced file's content (size/mtime) changes", async () => {
    const a = computeContentHash(minimalTimeline(), [fileA], settings);
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(fileA, "frame-1-but-different-length");
    const b = computeContentHash(minimalTimeline(), [fileA], settings);
    expect(a).not.toBe(b);
  });

  it("changes when render settings change (e.g. draft vs full)", () => {
    const a = computeContentHash(minimalTimeline(), [fileA], settings);
    const b = computeContentHash(minimalTimeline(), [fileA], { ...settings, draft: true, fps: 15 });
    expect(a).not.toBe(b);
  });
});

describe("matchesCachedHash / writeHashSidecar", () => {
  let dir: string;
  let outputFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-hash-sidecar-"));
    outputFile = path.join(dir, "demo.mp4");
    await writeFile(outputFile, "fake-mp4-bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is false when there is no sidecar", () => {
    expect(matchesCachedHash(outputFile, "abc123")).toBe(false);
  });

  it("is false when the output file is missing, even with a matching sidecar", async () => {
    await writeFile(hashSidecarPath(outputFile), "abc123\n");
    await rm(outputFile);
    expect(matchesCachedHash(outputFile, "abc123")).toBe(false);
  });

  it("is true once the matching hash is written, false for a different hash", () => {
    writeHashSidecar(outputFile, "abc123");
    expect(matchesCachedHash(outputFile, "abc123")).toBe(true);
    expect(matchesCachedHash(outputFile, "def456")).toBe(false);
  });
});
