// The release video's cut (M48, render/release-cut.ts): card timelines (the guide's look, no
// screenshot, stage never shown), finding a built scene's cached segment by its hash, and laying
// pieces end to end with their captions, narration and chapters shifted to the cut. Then, behind
// AIDA_TEST_SLOW, real renders of two walkthroughs (one blurred) cut into a release video with
// real cards, compared frame by frame with the guides' own videos.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest } from "../../src/capture/index.js";
import { render } from "../../src/render/index.js";
import {
  assembleCut,
  buildCardTimeline,
  cardSeconds,
  chapterTitle,
  findSceneSegments,
  releaseCutHash,
  releaseNarrationArgs,
  runMediaTool,
  sceneHashSettings,
  type CutPiece,
} from "../../src/render/release-cut.js";
import { computeSceneHash, frameRangesForScenes, segmentPath } from "../../src/render/segments.js";
import { cameraAt, frameSignature } from "../../src/render/state.js";
import { buildTimeline } from "../../src/render/timeline.js";
import type { Timeline } from "../../src/render/types.js";
import { qualityFor } from "../../src/render/video.js";
import { checkCaptions, parseCaptions } from "../../src/qa/captions.js";
import { toChaptersVtt } from "../../src/render/captions.js";
import { buildReleaseVideo, type ReleaseVideoConfig } from "../../src/whats-new/release-video.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";
import { cleanupTmpDirs, solidPng, tmpDir } from "../ci/helpers.js";

const SLOW = process.env.AIDA_TEST_SLOW === "1";

afterEach(() => cleanupTmpDirs());

function guide(): { wf: Walkthrough; manifest: CaptureManifest } {
  const wf = {
    walkthrough: "add-entry",
    title: "Add an entry",
    product: "Acme Events",
    start: { page: "/entries" },
    steps: [
      { id: "one", title: "One", say: "Step one.", actions: [] },
      { id: "two", title: "Two", say: "Step two.", actions: [] },
    ],
  } as Walkthrough;
  const manifest = {
    workflow: "add-entry",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: wf.steps.map((s) => ({
      id: s.id!,
      camera: "full",
      cameraBox: null,
      events: [{ type: "frame", image: `${s.id}.png`, transition: "cut" }, { type: "hold", seconds: 0.5 }],
      doc: { image: `${s.id}.png`, highlights: [] },
      impact: { urls: [], requests: [] },
      checks: [],
    })),
  } as unknown as CaptureManifest;
  return { wf, manifest };
}

const beats = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { audioPath: `/voice/${id}.wav`, durationMs: 1500 }]));

describe("buildCardTimeline", () => {
  const { wf, manifest } = guide();
  const look = buildTimeline(wf, manifest, beats(["intro", "one", "two", "outro"]), {
    fps: 30,
    frameSrc: (f) => `/capture/frames/${f}`,
  });

  it("takes the guide's look, carries no screenshot and never shows the stage", () => {
    const tl = buildCardTimeline({ id: "card-open", eyebrow: "What's new", title: "2.4 <beta>", subtitle: "2 guides changed", say: "What's new in 2.4." }, { audioPath: "/v/open.wav", durationMs: 1800 }, look, 30);
    expect(tl.brand).toEqual(look.brand);
    expect(tl.stage).toEqual(look.stage);
    expect(tl.chrome).toBe(look.chrome);
    expect(tl.intro).toMatchObject({ eyebrow: "What's new", titleHtml: "2.4 &lt;beta&gt;", subtitle: "2 guides changed" });
    // The one frame cue is a blank data URL, and the reveal schedule has no hero image.
    expect(tl.frames).toHaveLength(1);
    expect(tl.frames[0].src.startsWith("data:image/png")).toBe(true);
    expect(JSON.stringify(tl)).not.toContain("/capture/frames/");
    expect(tl.cards!.intro.map((r) => r.id)).not.toContain("intro-hero");
    // Stage hidden on every frame, card fully up through its spoken line.
    expect(tl.duration).toBe(cardSeconds({ audioPath: "", durationMs: 1800 }));
    for (let i = 0; i < Math.round(tl.duration * 30); i++) {
      expect(JSON.parse(frameSignature(tl, i / 30))[0]).toBe(0);
    }
    expect(tl.audio).toEqual([{ id: "card-open", file: "/v/open.wav", t: 0.7 }]);
    expect(tl.captions).toEqual([{ t0: 0.7, t1: 2.8, text: "What's new in 2.4." }]);
    expect(tl.scenes).toEqual([{ id: "card-open", t0: 0, t1: tl.duration }]);
  });

  it("holds at least three seconds", () => {
    expect(cardSeconds({ audioPath: "", durationMs: 400 })).toBe(3);
    expect(cardSeconds({ audioPath: "", durationMs: 2500 })).toBe(4.2);
  });
});

describe("findSceneSegments", () => {
  it("finds the segment the build cached, under the hash renderScenesToSegments uses, and misses a stale one", () => {
    const dir = tmpDir("m48-release-segments-");
    const frames = join(dir, "frames");
    mkdirSync(frames, { recursive: true });
    for (const id of ["one", "two"]) writeFileSync(join(frames, `${id}.png`), solidPng(4, 4, [10, 20, 30]));
    const assets = join(dir, ".compose");
    mkdirSync(assets, { recursive: true });
    for (const f of ["index.html", "player.js", "player.css"]) writeFileSync(join(assets, f), f);
    const { wf, manifest } = guide();
    const quality = qualityFor(true, 10);
    // timeline.json as a full render wrote it: its fps isn't the draft's.
    const tl = buildTimeline(wf, manifest, beats(["intro", "one", "two", "outro"]), { fps: 30, frameSrc: (f) => join(frames, f) });
    const segmentsDir = join(dir, "segments", "draft");
    const expected = segmentPath(segmentsDir, "two", computeSceneHash({ ...tl, fps: 10 }, tl.scenes!.find((s) => s.id === "two")!, assets, { fps: 10, crf: 30, preset: "ultrafast", draft: true }, {}));
    mkdirSync(segmentsDir, { recursive: true });
    writeFileSync(expected, "segment");

    const [two, gone] = findSceneSegments(tl, ["two", "nope"], { assetsDir: assets, segmentsDir, quality, draft: true });
    expect(two).toMatchObject({ sceneId: "two", file: expected, exists: true });
    const scene = tl.scenes!.find((s) => s.id === "two")!;
    expect([two.start, two.end]).toEqual([Math.round(scene.t0 * 10), Math.round(scene.t1 * 10)]);
    expect(gone.exists).toBe(false);
    expect(sceneHashSettings(quality, true)).toEqual({ fps: 10, crf: 30, preset: "ultrafast", draft: true });

    // A recaptured frame changes the hash: the old segment no longer counts.
    writeFileSync(join(frames, "two.png"), solidPng(4, 4, [99, 20, 30]));
    expect(findSceneSegments(tl, ["two"], { assetsDir: assets, segmentsDir, quality, draft: true })[0].exists).toBe(false);
  });
});

describe("assembleCut", () => {
  const source = (captions: Timeline["captions"], audio: Timeline["audio"], clicks: Timeline["clicks"] = []) =>
    ({ captions, audio, clicks }) as Timeline;

  it("lays pieces end to end on frame boundaries and shifts captions, narration and clicks with them", () => {
    const card = source([{ t0: 0.7, t1: 2.5, text: "Card" }], [{ id: "card", file: "/c.wav", t: 0.7 }]);
    const guideTl = source(
      [
        { t0: 5.3, t1: 7.0, text: "Step two" },
        { t0: 8.3, t1: 9.5, text: "Step three" },
      ],
      [
        { id: "two", file: "/two.wav", t: 5.3 },
        { id: "three", file: "/three.wav", t: 8.3 },
      ],
      [{ t: 6.0, x: 1, y: 2 }],
    );
    const pieces: CutPiece[] = [
      { file: "/seg/card-open.mp4", start: 0, end: 30, source: card },
      { file: "/seg/card-g.mp4", start: 0, end: 30, source: card, chapter: 0 },
      // Step two of the guide: source frames 50..80 at 10 fps = 5.0 s .. 8.0 s.
      { file: "/seg/two.mp4", start: 50, end: 80, source: guideTl, chapter: 0 },
    ];
    const cut = assembleCut(pieces, ["Add an entry"], 10);
    expect(cut.duration).toBe(9);
    expect(cut.pieces.map((p) => p.at)).toEqual([0, 3, 6]);
    expect(cut.audio).toEqual([
      { id: "card", file: "/c.wav", t: 0.7 },
      { id: "card", file: "/c.wav", t: 3.7 },
      { id: "two", file: "/two.wav", t: 6.3 },
    ]);
    expect(cut.clicks).toEqual([{ t: 7, x: 1, y: 2 }]);
    expect(cut.captions).toEqual([
      { t0: 0.7, t1: 2.5, text: "Card" },
      { t0: 3.7, t1: 5.5, text: "Card" },
      { t0: 6.3, t1: 8, text: "Step two" },
    ]);
    expect(cut.chapters).toEqual([{ t0: 3, t1: 9, num: "1", eyebrow: "", title: "Add an entry" }]);
  });

  it("keeps captions from overlapping across a join", () => {
    const a = source([{ t0: 0.5, t1: 3.2, text: "A" }], []);
    const b = source([{ t0: 0, t1: 1, text: "B" }], []);
    const cut = assembleCut(
      [
        { file: "/a", start: 0, end: 30, source: a },
        { file: "/b", start: 0, end: 10, source: b },
      ],
      [],
      10,
    );
    expect(cut.captions).toEqual([
      { t0: 0.5, t1: 2.95, text: "A" },
      { t0: 3, t1: 4, text: "B" },
    ]);
  });

  it("keeps a caption in the piece it starts in, even when it runs past its scene's end", () => {
    // `voice.gapSeconds` below 0.3: step two's caption runs 0.2 s into step three.
    const tl = source(
      [
        { t0: 5.3, t1: 8.2, text: "Step two" },
        { t0: 8.3, t1: 9.5, text: "Step three" },
      ],
      [],
    );
    // Step three alone: source frames 80..100 at 10 fps = 8.0 s .. 10.0 s.
    const cut = assembleCut([{ file: "/three", start: 80, end: 100, source: tl }], [], 10);
    expect(cut.captions).toEqual([{ t0: 0.3, t1: 1.5, text: "Step three" }]);
    // Step two alone: its caption ends at the join.
    const two = assembleCut([{ file: "/two", start: 50, end: 80, source: tl }], [], 10);
    expect(two.captions).toEqual([{ t0: 0.3, t1: 3, text: "Step two" }]);
  });

  it("cuts a long guide title to one chapter line at a word boundary, as the QA gate requires", () => {
    const long = "Change the billing contact for a shared account"; // 48 characters
    const cut = assembleCut([{ file: "/a", start: 0, end: 10, source: source([], []), chapter: 0 }], [long], 10);
    expect(cut.chapters[0].title).toBe("Change the billing contact for a shared…");
    expect(cut.chapters[0].title.length).toBeLessThanOrEqual(42);
    const results = checkCaptions(parseCaptions(toChaptersVtt(cut.chapters), "vtt"));
    expect(results.find((r) => r.check === "captions:line-length")?.ok).toBe(true);
    expect(chapterTitle("Add an entry")).toBe("Add an entry");
  });

  it("hashes the segments, timing and words, not the machine", () => {
    const cut = assembleCut([{ file: "/x/seg/a-1234.mp4", start: 0, end: 10, source: source([], [{ id: "a", file: "/v/a.wav", t: 0.7 }]) }], [], 10);
    expect(releaseCutHash(cut, "What's new: 2.4", "en")).toBe(releaseCutHash(structuredClone(cut), "What's new: 2.4", "en"));
    expect(releaseCutHash(cut, "What's new: 2.5", "en")).not.toBe(releaseCutHash(cut, "What's new: 2.4", "en"));
  });
});

// Real renders (AIDA_TEST_SLOW=1, `npm run test:slow`): two two-step walkthroughs, the first
// with a blur box on its second step, rendered through the player (draft, 2 fps) the way the
// build renders them, then cut into a release video with cards rendered by the same player and
// the real QA gates. Every frame of the release video is decoded and compared: each reused scene
// with the same frames of its guide's own video, each card with its own segment, so every join
// is checked on both sides; and the blurred box is checked flat in every frame it's up.
describe.skipIf(!SLOW)("release video from real renders (slow)", () => {
  it("copies every frame of every reused scene and card exactly, and keeps the blurred box flat", async () => {
    const root = tmpDir("m48-release-real-");
    const BOX = { x: 300, y: 200, w: 400, h: 120 };
    const config = {
      configDir: root,
      buildDir: join(root, ".build"),
      outDir: join(root, "dist"),
      walkthroughsDir: join(root, "walkthroughs"),
      helpApp: join(root, "help"),
      lang: "en",
      publish: { siteUrl: "https://example.com/help" },
    } as ReleaseVideoConfig;
    mkdirSync(config.walkthroughsDir, { recursive: true });
    const voiceDir = join(root, "voice");
    mkdirSync(voiceDir, { recursive: true });
    const tone = (name: string, seconds: number) => {
      const file = join(voiceDir, `${name}-${seconds}.wav`);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-ac", "1", file]);
      return { audioPath: file, durationMs: seconds * 1000 };
    };
    // A busy checkerboard (a different cell size per guide), so an unblurred box never reads flat.
    const checker = (cell: number) => {
      const png = new PNG({ width: 1440, height: 810 });
      for (let y = 0; y < 810; y++) {
        for (let x = 0; x < 1440; x++) {
          const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 230 : 20;
          png.data.set([v, v, v, 255], (y * 1440 + x) * 4);
        }
      }
      return PNG.sync.write(png);
    };

    const guides = [
      { id: "add-entry", title: "Add an entry", cell: 8, blur: true },
      { id: "pay-invoice", title: "Pay an invoice", cell: 16, blur: false },
    ];
    const sources = new Map<string, { tl: Timeline; mp4: string }>();
    for (const g of guides) {
      const captureDir = join(config.buildDir, g.id, "capture");
      mkdirSync(join(captureDir, "frames"), { recursive: true });
      const { manifest } = guide();
      manifest.workflow = g.id;
      for (const id of ["one", "two"]) writeFileSync(join(captureDir, "frames", `${id}.png`), checker(g.cell));
      if (g.blur) (manifest.steps[1].doc as { blur?: unknown }).blur = [{ id: "email", box: BOX }];
      writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(join(captureDir, "validation.json"), JSON.stringify({ ok: true, steps: [] }));
      writeFileSync(join(config.buildDir, g.id, "pages-cache.json"), JSON.stringify({ result: { publishable: true } }));
      writeFileSync(join(config.buildDir, g.id, "qa.json"), JSON.stringify({ ok: true }));
      const file = join(config.walkthroughsDir, `${g.id}.yaml`);
      writeFileSync(
        file,
        [`walkthrough: ${g.id}`, "version: 1", `title: ${g.title}`, "start:", "  page: /entries", "steps:",
          "  - id: one", "    title: One", "    say: Step one.", "    actions: []",
          "  - id: two", "    title: Two", "    say: Step two.", "    actions: []",
          ...(g.blur ? ["    blur:", "      - id: email", "        target:", "          text: x"] : []), ""].join("\n"),
      );
      // As the build renders it: the walkthrough as loaded from its file.
      const wf = loadWalkthroughFile(file);
      const narration = { intro: tone("intro", 1.2), one: tone("one", 1.2), two: tone("two", 1.2), outro: tone("outro", 1) };
      const built = await render(wf, { outDir: join(config.outDir, "videos"), captureDir, narration, draft: true, fps: 2, pathClips: false, concurrency: 1 });
      expect(built.mp4).toBeDefined();
      sources.set(g.id, { tl: JSON.parse(readFileSync(built.timelineJson, "utf8")) as Timeline, mp4: built.mp4! });
      // Published as the index stage would: the page staged, its own video on the site.
      const page = join(config.helpApp!, "content", "docs", "how-do-i", g.id);
      mkdirSync(page, { recursive: true });
      writeFileSync(join(page, "index.mdx"), `---\ntitle: "${g.title}"\nwalkthrough: ${g.id}\n---\n`);
      mkdirSync(join(config.helpApp!, "public", "videos", g.id), { recursive: true });
      copyFileSync(built.mp4!, join(config.helpApp!, "public", "videos", g.id, `${g.id}.mp4`));
    }

    const r = await buildReleaseVideo({
      config,
      base: "v0",
      release: "2.4",
      dateLabel: "11 November 2026",
      draft: true,
      fps: 2,
      tolerance: 0,
      // About as long as a voice takes to say it (15 chars a second).
      narrate: async (lines) => Object.fromEntries(lines.map((l) => [l.id, tone(l.id, Math.max(1, Math.ceil(l.text.length / 15)))])),
      affected: async () => ({ ids: guides.map((g) => g.id) }),
    });
    expect(r.qa?.problems).toEqual([]);
    expect(r.status).toBe("written");
    expect(r.guides.map((g) => [g.id, g.steps])).toEqual([["add-entry", [1, 2]], ["pay-invoice", [1, 2]]]);

    const fps = 2;
    const decode = (file: string): { w: number; h: number; frames: Buffer[] } => {
      const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" })
        .trim()
        .split(",")
        .map(Number);
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { maxBuffer: 1024 * 1024 * 1024 });
      const size = (w * h * 3) / 2;
      const frames: Buffer[] = [];
      for (let o = 0; o + size <= raw.length; o += size) frames.push(raw.subarray(o, o + size));
      return { w, h, frames };
    };
    const release = decode(r.files!.mp4);
    const sameFrames = (what: string, got: Buffer[], want: Buffer[]) => {
      expect(got.length, `${what}: frame count`).toBe(want.length);
      got.forEach((f, i) => expect(f.equals(want[i]), `${what}: frame ${i}`).toBe(true));
    };

    // Lay the pieces out from the chapters: each chapter is its guide card, then its scenes.
    const chapters = parseCaptions(readFileSync(r.files!.chaptersVtt, "utf8"), "vtt");
    expect(chapters.map((c) => c.text)).toEqual(["Add an entry", "Pay an invoice"]);
    const cardFile = (id: string) => {
      const dir = join(config.outDir, "videos", "_whats-new", "segments", "draft");
      const name = readdirSync(dir).find((n) => n.startsWith(`${id}-`) && n.endsWith(".mp4"))!;
      return join(dir, name);
    };
    let at = 0;
    const take = (n: number) => {
      const out = release.frames.slice(at, at + n);
      at += n;
      return out;
    };
    const opening = decode(cardFile("opening")).frames;
    sameFrames("opening card", take(opening.length), opening);
    for (const [i, g] of guides.entries()) {
      expect(at, `${g.id} starts where its chapter does`).toBe(Math.round((chapters[i].startMs / 1000) * fps));
      const card = decode(cardFile(`guide-${g.id}`)).frames;
      sameFrames(`${g.id} card`, take(card.length), card);
      const { tl, mp4 } = sources.get(g.id)!;
      const own = decode(mp4).frames;
      const ranges = frameRangesForScenes(tl.scenes!, fps);
      for (const sceneId of ["one", "two"]) {
        const k = tl.scenes!.findIndex((s) => s.id === sceneId);
        const sceneAt = at;
        const got = take(ranges[k].end - ranges[k].start);
        sameFrames(`${g.id} scene ${sceneId}`, got, own.slice(ranges[k].start, ranges[k].end));

        // The blurred box, flat in every frame of the scene while its blur window is up.
        const windows = (tl.blur ?? []).filter((b) => b.boxes.length > 0);
        if (!g.blur || sceneId !== "two") continue;
        expect(windows.length).toBeGreaterThan(0);
        got.forEach((frame, j) => {
          const tSource = (ranges[k].start + j) / fps;
          if (!windows.some((b) => tSource >= b.t0 + 0.5 && tSource < b.t1 - 0.5)) return;
          const scale = release.w / 1920;
          const K = tl.stage.w / tl.viewport.w;
          const c = cameraAt(tl, tSource);
          const VW = tl.viewport.w;
          const VH = tl.viewport.h;
          const cx = Math.min(VW - VW / 2 / c.z, Math.max(VW / 2 / c.z, c.cx));
          const cy = Math.min(VH - VH / 2 / c.z, Math.max(VH / 2 / c.z, c.cy));
          const sx = (vx: number) => (tl.stage.x + tl.stage.w / 2 + (vx - cx) * K * c.z) * scale;
          const sy = (vy: number) => (tl.stage.y + tl.stage.h / 2 + (vy - cy) * K * c.z) * scale;
          let min = 255;
          let max = 0;
          for (let y = Math.ceil(sy(BOX.y + 16)); y < Math.floor(sy(BOX.y + BOX.h - 16)); y++) {
            for (let x = Math.ceil(sx(BOX.x + 16)); x < Math.floor(sx(BOX.x + BOX.w - 16)); x++) {
              const v = frame[y * release.w + x];
              min = Math.min(min, v);
              max = Math.max(max, v);
            }
          }
          expect(max - min, `spread of luma inside the blurred box, release frame ${sceneAt + j}`).toBeLessThanOrEqual(12);
        });
      }
      expect(at, `${g.id}'s chapter ends after its last scene`).toBe(Math.round((chapters[i].endMs / 1000) * fps));
    }
    const closing = decode(cardFile("closing")).frames;
    sameFrames("closing card", take(closing.length), closing);
    expect(at, "every frame of the release video is accounted for").toBe(release.frames.length);
  }, 900_000);
});

// Release-video tests once left ffmpeg narration mixes running for hours at full CPU, deaf to
// SIGTERM: the mix padded with a bare `apad` (endless) and relied on `atrim` to end the graph,
// which ffmpeg 8 sometimes never does. Every ffmpeg the release video starts must end by itself,
// and be killed when its caller gives up.
describe("the release video's ffmpeg runs end", () => {
  // The cues of the mix that hung: seven clips, an 18 s cut.
  const cut = {
    duration: 18,
    clicks: [],
    audio: [0.7, 4.9, 8.6, 10.2, 12.1, 15, 16.6].map((t, i) => ({ id: `c${i}`, file: `/voice/tone-${i}.wav`, t })),
  };

  it("pads the narration to the cut's length and no further", () => {
    const args = releaseNarrationArgs(cut, "/w/tick.wav", "/w/narration.m4a");
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Every apad is bounded; nothing loops or generates without end.
    expect(graph.match(/apad[^,;[]*/g)).toEqual(["apad=whole_dur=18"]);
    expect(graph).toContain("atrim=0:18");
    expect(graph).not.toMatch(/aevalsrc|anullsrc|sine=|stream_loop/);
    expect(args).not.toContain("-stream_loop");
  });

  it("mixes to exactly the cut's length, every time", async () => {
    const dir = tmpDir("m48-release-mix-");
    const clips = [2.4, 2.4, 0.8, 0.8, 1.6, 0.8, 0.8].map((seconds, i) => {
      const file = join(dir, `tone-${i}.wav`);
      execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-ac", "1", "-ar", "44100", file], { stdio: "ignore" });
      return file;
    });
    const real = { ...cut, audio: cut.audio.map((a, i) => ({ ...a, file: clips[i] })) };
    // The old graph hung about one run in twenty; a few at once give it a chance to show.
    const outs = await Promise.all(
      [0, 1, 2, 3].map(async (n) => {
        const out = join(dir, `narration-${n}.m4a`);
        await runMediaTool("ffmpeg", releaseNarrationArgs(real, join(dir, "tick.wav"), out), { timeoutMs: 60_000 });
        return out;
      }),
    );
    for (const out of outs) {
      const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" }).trim());
      expect(seconds).toBeGreaterThan(17.9);
      expect(seconds).toBeLessThan(18.1);
    }
  }, 120_000);

  /** A stand-in ffmpeg that ignores SIGTERM and never ends, recording its arguments and stdin. */
  function stuckFfmpeg(): { tool: string; record: string } {
    const dir = tmpDir("m48-stuck-ffmpeg-");
    const record = join(dir, "record.json");
    const tool = join(dir, "ffmpeg");
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

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("kills a run that doesn't end within its time, though it ignores SIGTERM, and gives it no stdin", async () => {
    const { tool, record } = stuckFfmpeg();
    const started = Date.now();
    await expect(runMediaTool(tool, ["-y", "-v", "error", "out.m4a"], { timeoutMs: 1500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const seen = JSON.parse(readFileSync(record, "utf8")) as { pid: number; args: string[]; stdin: string };
    expect(seen.args[0]).toBe("-nostdin");
    if (process.platform === "linux") expect(seen.stdin).toBe("/dev/null");
    expect(alive(seen.pid)).toBe(false);
  }, 20_000);

  it("kills a run as soon as its caller gives up", async () => {
    const { tool, record } = stuckFfmpeg();
    const stop = new AbortController();
    const run = runMediaTool(tool, ["-y", "out.m4a"], { timeoutMs: 600_000, signal: stop.signal });
    for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 50));
    stop.abort("the test gave up");
    await expect(run).rejects.toThrow(/the test gave up/);
    expect(alive((JSON.parse(readFileSync(record, "utf8")) as { pid: number }).pid)).toBe(false);
  }, 20_000);
});
