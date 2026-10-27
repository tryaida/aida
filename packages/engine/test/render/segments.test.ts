import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTimeline } from "../../src/render/timeline.js";
import { computeSceneHash, frameRangesForScenes, sliceTimelineForScene } from "../../src/render/segments.js";
import type { CaptureManifest } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";
import type { FileHashCache, HashSettings } from "../../src/render/hash.js";

function twoStepWf(): Walkthrough {
  return {
    walkthrough: "demo",
    title: "Demo walkthrough",
    product: "Demo",
    intro: { eyebrow: "How-to", title: "Demo walkthrough", subtitle: "A short demo", say: "Intro narration", caption: "Intro caption" },
    outro: { title: "Done", recap: ["Step one"], say: "Outro narration", caption: "Outro caption" },
    steps: [
      { id: "step-one", chapter: "Chapter A", title: "Step one", say: "s1", caption: "c1", camera: "full", actions: [] },
      { id: "step-two", chapter: "Chapter A", title: "Step two", say: "s2", caption: "c2", camera: "full", actions: [] },
    ],
  };
}

function twoStepManifest(frame1: string, frame2: string): CaptureManifest {
  return {
    workflow: "demo",
    capturedAt: new Date().toISOString(),
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    steps: [
      {
        id: "step-one",
        camera: "full",
        cameraBox: null,
        events: [{ type: "frame", image: frame1, transition: "cut" }],
        doc: { image: frame1, highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
      {
        id: "step-two",
        camera: "full",
        cameraBox: null,
        events: [{ type: "frame", image: frame2, transition: "cut" }],
        doc: { image: frame2, highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  };
}

const narration = {
  intro: { audioPath: "/voice/intro.wav", durationMs: 2000 },
  "step-one": { audioPath: "/voice/step-one.wav", durationMs: 2000 },
  "step-two": { audioPath: "/voice/step-two.wav", durationMs: 2000 },
  outro: { audioPath: "/voice/outro.wav", durationMs: 1000 },
};

const settings: HashSettings = { fps: 30, crf: 17, preset: "slow", draft: false };

describe("sliceTimelineForScene", () => {
  it("scopes each step scene to only its own frame", () => {
    const tl = buildTimeline(twoStepWf(), twoStepManifest("/frames/0001.png", "/frames/0002.png"), narration, { fps: 30, frameSrc: (f: string) => f });
    const stepOneScene = tl.scenes!.find((s) => s.id === "step-one")!;
    const stepTwoScene = tl.scenes!.find((s) => s.id === "step-two")!;

    const sliceOne = sliceTimelineForScene(tl, stepOneScene) as any;
    const sliceTwo = sliceTimelineForScene(tl, stepTwoScene) as any;

    expect(sliceOne.frames.map((f: any) => f.src)).toEqual(["/frames/0001.png"]);
    expect(sliceTwo.frames.map((f: any) => f.src)).toEqual(["/frames/0002.png"]);
  });
});

describe("computeSceneHash", () => {
  let dir: string;
  let assetsDir: string;
  let frame1: string;
  let frame2: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-segments-"));
    assetsDir = path.join(dir, "bundle");
    frame1 = path.join(dir, "0001.png");
    frame2 = path.join(dir, "0002.png");
    await Promise.all([writeFile(frame1, "frame-one-bytes"), writeFile(frame2, "frame-two-bytes")]);
    // Minimal player-asset stand-ins — computeSceneHash just hashes their bytes.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, "index.html"), "<html></html>");
    await writeFile(path.join(assetsDir, "player.js"), "// player");
    await writeFile(path.join(assetsDir, "player.css"), "/* css */");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function timelineWith(frame1Path: string, frame2Path: string) {
    return buildTimeline(twoStepWf(), twoStepManifest(frame1Path, frame2Path), narration, { fps: 30, frameSrc: (f: string) => f });
  }

  it("changes only the touched scene's hash when only that step's frame changes", async () => {
    const cache: FileHashCache = {};
    const tlBefore = timelineWith(frame1, frame2);
    const sceneOneBefore = tlBefore.scenes!.find((s) => s.id === "step-one")!;
    const sceneTwoBefore = tlBefore.scenes!.find((s) => s.id === "step-two")!;
    const introSceneBefore = tlBefore.scenes!.find((s) => s.id === "intro")!;

    const hashOneBefore = computeSceneHash(tlBefore, sceneOneBefore, assetsDir, settings, cache);
    const hashTwoBefore = computeSceneHash(tlBefore, sceneTwoBefore, assetsDir, settings, cache);
    const hashIntroBefore = computeSceneHash(tlBefore, introSceneBefore, assetsDir, settings, cache);

    // Change only step-two's frame content.
    await writeFile(frame2, "frame-two-bytes-CHANGED");
    const tlAfter = timelineWith(frame1, frame2);
    const sceneOneAfter = tlAfter.scenes!.find((s) => s.id === "step-one")!;
    const sceneTwoAfter = tlAfter.scenes!.find((s) => s.id === "step-two")!;
    const introSceneAfter = tlAfter.scenes!.find((s) => s.id === "intro")!;

    const hashOneAfter = computeSceneHash(tlAfter, sceneOneAfter, assetsDir, settings, cache);
    const hashTwoAfter = computeSceneHash(tlAfter, sceneTwoAfter, assetsDir, settings, cache);
    const hashIntroAfter = computeSceneHash(tlAfter, introSceneAfter, assetsDir, settings, cache);

    expect(hashTwoAfter).not.toBe(hashTwoBefore);
    expect(hashOneAfter).toBe(hashOneBefore);
    expect(hashIntroAfter).toBe(hashIntroBefore);
  });

  // Regression test for the stale-outro/intro-state bug: a scene's hash must also cover the
  // state `renderAt(t0)` reads back from *earlier* scenes (segments.ts's `entryState`), not
  // just its own sliced cues — otherwise the last step's screenshot (still on screen behind the
  // fading-in outro card) or an in-flight cursor/camera move never invalidates the scene that
  // inherits it.
  it("changes the outro scene's hash when the last step's final frame changes (frame still visible behind the outro card)", async () => {
    const cache: FileHashCache = {};
    const tlBefore = timelineWith(frame1, frame2);
    const outroBefore = tlBefore.scenes!.find((s) => s.id === "outro")!;
    const hashOutroBefore = computeSceneHash(tlBefore, outroBefore, assetsDir, settings, cache);

    // step-two's frame is the last frame cue in the whole timeline — it's what's still visible
    // (behind the stage-out fade) for the entire outro scene, even though outro's own sliced
    // `frames` is empty.
    const outroSliceBefore = sliceTimelineForScene(tlBefore, outroBefore) as any;
    expect(outroSliceBefore.frames).toEqual([]);
    expect(outroSliceBefore.entryState.frame.src).toBe(frame2);

    await writeFile(frame2, "frame-two-bytes-CHANGED");
    const tlAfter = timelineWith(frame1, frame2);
    const outroAfter = tlAfter.scenes!.find((s) => s.id === "outro")!;
    const hashOutroAfter = computeSceneHash(tlAfter, outroAfter, assetsDir, settings, cache);

    expect(hashOutroAfter).not.toBe(hashOutroBefore);
  });

  // Regression test for the same bug, cursor side: a move that finishes entirely inside one
  // step (so it never appears in the next step's own sliced `moves`) still leaves the cursor at
  // its end position when the next step begins, and `renderAt(t0)` paints the cursor there.
  it("changes the next step's hash when an earlier step's cursor move end position changes, even though the move itself isn't in that step's own slice", () => {
    const cache: FileHashCache = {};
    const manifestWithMove = (moveTo: { x: number; y: number }): CaptureManifest => ({
      workflow: "demo",
      capturedAt: new Date().toISOString(),
      baseUrl: "http://localhost",
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 2,
      steps: [
        {
          id: "step-one",
          camera: "full",
          cameraBox: null,
          events: [
            { type: "frame", image: frame1, transition: "cut" },
            { type: "move", to: moveTo },
          ],
          doc: { image: frame1, highlights: [] },
          impact: { urls: [], requests: [] },
          checks: [],
        },
        {
          id: "step-two",
          camera: "full",
          cameraBox: null,
          events: [{ type: "frame", image: frame2, transition: "cut" }],
          doc: { image: frame2, highlights: [] },
          impact: { urls: [], requests: [] },
          checks: [],
        },
      ],
    });

    const tlA = buildTimeline(twoStepWf(), manifestWithMove({ x: 300, y: 300 }), narration, { fps: 30, frameSrc: (f: string) => f });
    const tlB = buildTimeline(twoStepWf(), manifestWithMove({ x: 900, y: 150 }), narration, { fps: 30, frameSrc: (f: string) => f });
    const sceneTwoA = tlA.scenes!.find((s) => s.id === "step-two")!;
    const sceneTwoB = tlB.scenes!.find((s) => s.id === "step-two")!;

    // step-two's own sliced cues don't see step-one's move at all — it finishes before
    // step-two starts — so without the fix, step-two's hash would be identical in both cases.
    const sliceTwoA = sliceTimelineForScene(tlA, sceneTwoA) as any;
    const sliceTwoB = sliceTimelineForScene(tlB, sceneTwoB) as any;
    expect(sliceTwoA.moves).toEqual([]);
    expect(sliceTwoB.moves).toEqual([]);
    expect(sliceTwoA.entryState.cursor).not.toEqual(sliceTwoB.entryState.cursor);

    const hashTwoA = computeSceneHash(tlA, sceneTwoA, assetsDir, settings, cache);
    const hashTwoB = computeSceneHash(tlB, sceneTwoB, assetsDir, settings, cache);
    expect(hashTwoA).not.toBe(hashTwoB);
  });

  it("is stable for the same scene, files and settings", () => {
    const cache: FileHashCache = {};
    const tl = timelineWith(frame1, frame2);
    const scene = tl.scenes!.find((s) => s.id === "step-one")!;
    const a = computeSceneHash(tl, scene, assetsDir, settings, cache);
    const b = computeSceneHash(tl, scene, assetsDir, settings, cache);
    expect(a).toBe(b);
  });

  it("changes when render settings change (draft vs full)", () => {
    const cache: FileHashCache = {};
    const tl = timelineWith(frame1, frame2);
    const scene = tl.scenes!.find((s) => s.id === "step-one")!;
    const a = computeSceneHash(tl, scene, assetsDir, settings, cache);
    const b = computeSceneHash(tl, scene, assetsDir, { ...settings, draft: true, fps: 15 }, cache);
    expect(a).not.toBe(b);
  });
});

describe("frameRangesForScenes (concat duration math)", () => {
  it("produces contiguous, gap-free ranges whose total frame count matches the timeline duration", () => {
    const tl = buildTimeline(twoStepWf(), twoStepManifest("/frames/0001.png", "/frames/0002.png"), narration, { fps: 30, frameSrc: (f: string) => f });
    const ranges = frameRangesForScenes(tl.scenes!, 30);

    expect(ranges[0].start).toBe(0);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].start).toBe(ranges[i - 1].end);

    const totalFrames = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
    // Within one frame of fps * duration — the ±1 frame tolerance the spec allows for rounding.
    expect(Math.abs(totalFrames - tl.duration * 30)).toBeLessThanOrEqual(1);
    expect(ranges[ranges.length - 1].end).toBe(Math.round(tl.duration * 30));
  });
});
