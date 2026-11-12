// The release "what changed" video end to end on a small app the last build left on disk (M48):
// who takes part, the cut's order and caps, captions/chapters/transcript timed to it, a missing
// segment, blur surviving the cut, the QA gate, the page block, and the command's --json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWhatsNew } from "../../src/commands/whats-new.js";
import { createFakeCommandRunner } from "../../src/publish/index.js";
import { parseCaptions } from "../../src/qa/captions.js";
import type { QaReport } from "../../src/qa/run.js";
import { buildWhatsNew } from "../../src/whats-new/build.js";
import { findSceneSegments } from "../../src/render/release-cut.js";
import { qualityFor } from "../../src/render/video.js";
import { readReleaseManifest } from "../../src/whats-new/published.js";
import { buildReleaseVideo, releaseVideoPaths, type BuildReleaseVideoOptions } from "../../src/whats-new/release-video.js";
import { guideCard, openingCard, videoBlock, type ReleaseGuideText } from "../../src/whats-new/release-text.js";
import { cleanupTmpDirs } from "../ci/helpers.js";
import { BLUR_BOX, FPS, SIZE, colourSegment, fakeCardRenderer, makeFixture, writeWalkthrough, type Fixture, type GuideSpec } from "./release-fixture.js";

afterEach(() => cleanupTmpDirs());

const RED: [number, number, number] = [220, 30, 30];
const GREY: [number, number, number] = [200, 200, 200];
const grey = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, GREY]));

const passQa = async (files: string[]): Promise<QaReport[]> => files.map((target) => ({ ok: true, target, checks: [{ check: "fake", ok: true, details: "", problems: [] }] }));

function options(f: Fixture, extra: Partial<BuildReleaseVideoOptions> = {}): BuildReleaseVideoOptions {
  return {
    config: f.config,
    base: f.baseSha,
    release: "2.4",
    dateLabel: "11 November 2026",
    draft: true,
    fps: FPS,
    tolerance: 0,
    narrate: async (lines) => Object.fromEntries(lines.map((l) => [l.id, f.voice(l.text)])),
    renderCard: fakeCardRenderer,
    qa: passQa,
    ...extra,
  };
}

/** Two changed guides (screenshots: steps 2 and 3; a new guide), one unchanged. */
const APP: GuideSpec[] = [
  { id: "add-entry", title: "Add an entry", steps: 4, base: grey(4), now: { 2: RED, 3: RED } },
  { id: "pay-invoice", title: "Pay an invoice", steps: 2, base: null },
  { id: "export-report", title: "Export a report", steps: 2, base: grey(2) },
];

const probeSeconds = (file: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" }).trim());

/** The luma of one decoded frame at `t` seconds, as a greyscale PNG. */
function frameAt(file: string, t: number): PNG {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "image2pipe", "-c:v", "png", "-"]);
  return PNG.sync.read(buf);
}

function spread(png: PNG, box: { x: number; y: number; w: number; h: number }, inset: number): number {
  let min = 255;
  let max = 0;
  for (let y = box.y + inset; y < box.y + box.h - inset; y++) {
    for (let x = box.x + inset; x < box.x + box.w - inset; x++) {
      const v = png.data[(y * png.width + x) * 4];
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  return max - min;
}

describe("buildReleaseVideo", () => {
  it("cuts the opening card, each guide's card and changed scenes in order, then the closing card", async () => {
    const f = await makeFixture(APP, { siteUrl: "https://example.com/help" });
    const r = await buildReleaseVideo(options(f));

    expect(r.status).toBe("written");
    expect(r.guides.map((g) => [g.id, g.rule, g.steps])).toEqual([
      ["add-entry", "screenshots", [2, 3]],
      ["pay-invoice", "new", [1, 2]],
    ]);
    expect(r.leftOut).toEqual([]);

    // Timing: the chapters, captions and the video itself agree on one clock.
    const files = r.files!;
    expect(probeSeconds(files.mp4)).toBeCloseTo(r.durationSec!, 0);
    const chapters = parseCaptions(readFileSync(files.chaptersVtt, "utf8"), "vtt");
    expect(chapters.map((c) => c.text)).toEqual(["Add an entry", "Pay an invoice"]);
    const scene = (id: string, step: string) => f.timelines.get(id)!.scenes!.find((s) => s.id === step)!;
    const frames = (id: string, step: string) => Math.round(scene(id, step).t1 * FPS) - Math.round(scene(id, step).t0 * FPS);
    // Chapter 1 runs from its card through steps 2 and 3; chapter 2 starts right after.
    expect(chapters[1].startMs - chapters[0].startMs).toBeGreaterThan(0);
    expect(chapters[0].endMs).toBe(chapters[1].startMs);
    const guideCardSeconds = (chapters[0].endMs - chapters[0].startMs) / 1000 - (frames("add-entry", "step-2") + frames("add-entry", "step-3")) / FPS;
    expect(guideCardSeconds).toBeGreaterThanOrEqual(3 - 1 / FPS);
    // The closing card follows the last chapter to the end.
    expect(r.durationSec! - chapters[1].endMs / 1000).toBeGreaterThanOrEqual(3 - 1 / FPS);

    const captions = parseCaptions(readFileSync(files.srt, "utf8"), "srt");
    const texts = captions.map((c) => c.text.replace(/\n/g, " "));
    expect(texts[0]).toBe("What's new in 2.4: 2 guides changed.");
    expect(texts).toContain("Add an entry: steps 2 and 3 changed.");
    expect(texts).toContain("New guide: Pay an invoice.");
    expect(texts[texts.length - 1]).toBe("Every guide is at example.com/help.");
    // Step 2's caption sits inside chapter 1, after the guide card: shifted to the cut.
    const step2 = captions.find((c) => c.text === "This is step 2.")!;
    expect(step2.startMs).toBeGreaterThan(chapters[0].startMs + 2900);
    expect(step2.endMs).toBeLessThanOrEqual(chapters[0].endMs);
    for (let i = 1; i < captions.length; i++) expect(captions[i].startMs).toBeGreaterThanOrEqual(captions[i - 1].endMs);

    const transcript = readFileSync(files.transcript, "utf8");
    expect(transcript).toBe(
      [
        "# What's new: 2.4",
        "",
        "## What's new",
        "",
        "What's new in 2.4: 2 guides changed.",
        "",
        `## Add an entry (0:0${Math.floor(chapters[0].startMs / 1000)})`,
        "",
        "Add an entry: steps 2 and 3 changed.",
        "",
        "### 2. Step 2 of Add an entry",
        "",
        "This is step 2.",
        "",
        "### 3. Step 3 of Add an entry",
        "",
        "This is step 3.",
        "",
        `## Pay an invoice (0:${String(Math.floor(chapters[1].startMs / 1000)).padStart(2, "0")})`,
        "",
        "New guide: Pay an invoice.",
        "",
        "### 1. Step 1 of Pay an invoice",
        "",
        "This is step 1.",
        "",
        "### 2. Step 2 of Pay an invoice",
        "",
        "This is step 2.",
        "",
        "## That's what's new",
        "",
        "Every guide is at example.com/help.",
        "",
      ].join("\n"),
    );

    // Copied into the help app, and the page block embeds it like a guide's video.
    const staged = join(f.config.helpApp!, "public", "videos", "_whats-new");
    for (const name of ["whats-new.mp4", "whats-new.srt", "whats-new.vtt", "whats-new.chapters.vtt", "whats-new.transcript.md"]) {
      expect(existsSync(join(staged, name)), name).toBe(true);
    }
    expect(r.block!.content).toBe(
      [
        '<VideoEmbed src={"/videos/_whats-new/whats-new.mp4"} vtt={"/videos/_whats-new/whats-new.vtt"} srt={"/videos/_whats-new/whats-new.srt"} chapters={"/videos/_whats-new/whats-new.chapters.vtt"} transcript={"/videos/_whats-new/whats-new.transcript.md"} title={"What\'s new: 2.4"} />',
        "",
        "In this video: [Add an entry](/how-do-i/add-entry) (steps 2 and 3), [Pay an invoice](/how-do-i/pay-invoice) (new guide).",
      ].join("\n"),
    );
  }, 180_000);

  it("leaves out unpublishable guides, whatever their screenshots say", async () => {
    const f = await makeFixture([
      { id: "add-entry", title: "Add an entry", steps: 2, base: grey(2), now: { 1: RED } },
      { id: "broken", title: "Broken capture", steps: 2, base: grey(2), now: { 1: RED }, captureOk: false },
      { id: "failed-qa", title: "Failed QA", steps: 2, base: null, qaOk: false },
    ]);
    const r = await buildReleaseVideo(options(f));
    expect(r.guides.map((g) => g.id)).toEqual(["add-entry"]);
    expect(r.excluded).toEqual([
      { id: "broken", reason: "its capture didn't pass" },
      { id: "failed-qa", reason: "it failed QA" },
    ]);
    expect(readFileSync(r.files!.transcript, "utf8")).not.toMatch(/Broken|Failed QA/);
  }, 180_000);

  it("caps guides per video and steps per guide, and says what was left out", async () => {
    const f = await makeFixture(APP);
    const r = await buildReleaseVideo(options(f, { maxGuides: 1, maxStepsPerGuide: 1 }));
    expect(r.guides.map((g) => [g.id, g.steps])).toEqual([["add-entry", [2]]]);
    // The opening card counts every guide that changed, not just the one shown.
    const first = parseCaptions(readFileSync(r.files!.srt, "utf8"), "srt")[0].text.replace(/\n/g, " ");
    expect(first).toBe("What's new in 2.4: 2 guides changed; this video shows 1 of them.");
    expect(r.leftOut).toEqual([
      { id: "add-entry", title: "Add an entry", steps: [3], reason: "at most 1 step per guide", why: "short" },
      { id: "pay-invoice", title: "Pay an invoice", steps: [1, 2], reason: "at most 1 guide per video", why: "short" },
    ]);
    expect(r.block!.content).toContain(
      "Also changed, left out to keep the video short: [Add an entry](/how-do-i/add-entry) (also step 3), [Pay an invoice](/how-do-i/pay-invoice) (steps 1 and 2).",
    );
  }, 180_000);

  it("keeps to the time budget, the first guide's first scene always in", async () => {
    const f = await makeFixture(APP);
    const r = await buildReleaseVideo(options(f, { maxSeconds: 8 }));
    expect(r.guides.map((g) => [g.id, g.steps])).toEqual([["add-entry", [2]]]);
    expect(r.leftOut.map((l) => [l.id, l.steps, l.reason])).toEqual([
      ["add-entry", [3], "keeps the video under 8 seconds"],
      ["pay-invoice", [1, 2], "keeps the video under 8 seconds"],
    ]);
  }, 180_000);

  it("names the build command when a needed segment is missing, and renders nothing", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 3, base: grey(3), now: { 2: RED }, noSegments: true }]);
    const renderCard = vi.fn(fakeCardRenderer);
    const r = await buildReleaseVideo(options(f, { renderCard }));
    expect(r).toMatchObject({
      status: "missing-segments",
      ok: false,
      missing: [{ id: "add-entry", step: 2, stepId: "step-2" }],
      buildCommand: "aida build add-entry --draft",
    });
    expect(r.message).toContain("run `aida build add-entry --draft`");
    expect(r.block).toBeUndefined();
    expect(renderCard).not.toHaveBeenCalled();
    expect(existsSync(releaseVideoPaths(f.config).files.mp4)).toBe(false);
  }, 180_000);

  it("writes no video when nothing changed, and takes an older one off the site", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 2, base: grey(2), now: { 1: RED } }]);
    expect((await buildReleaseVideo(options(f))).status).toBe("written");
    const staged = releaseVideoPaths(f.config).publicDir!;
    expect(existsSync(join(staged, "whats-new.mp4"))).toBe(true);

    // The release is published: its screenshots are the new base.
    execFileSync("git", ["add", "-A"], { cwd: f.root });
    execFileSync("git", ["commit", "-q", "-m", "release"], { cwd: f.root });
    const r = await buildReleaseVideo(options(f, { base: "HEAD" }));
    expect(r.status).toBe("nothing-changed");
    expect(r.ok).toBe(true);
    expect(r.block).toBeNull();
    expect(r.message).toBe("no guide changed since HEAD: no video");
    expect(existsSync(join(staged, "whats-new.mp4"))).toBe(false);
  }, 180_000);

  // Synthetic segments: this shows the `-c copy` join carries a scene's pixels unchanged at one
  // mid-scene time (a flat box stays flat). The slow test in test/render/release-cut.test.ts
  // compares every frame of real renders.
  it("stream-copies a scene's pixels, so a flat box in a segment is still flat mid-scene in the cut", async () => {
    const f = await makeFixture([{ id: "account", title: "Change your email", steps: 2, base: grey(2), now: { 2: RED }, blur: true }]);
    const r = await buildReleaseVideo(options(f));
    expect(r.status).toBe("written");
    const chapters = parseCaptions(readFileSync(r.files!.chaptersVtt, "utf8"), "vtt");
    // Middle of the scene, past the guide card.
    const t = (chapters[0].endMs - 400) / 1000;
    const png = frameAt(r.files!.mp4, t);
    expect(png.width).toBe(SIZE.w);
    expect(spread(png, BLUR_BOX, 3)).toBeLessThanOrEqual(6);
    // ...while the rest of the frame is the busy screen around it.
    expect(spread(png, { x: 0, y: 0, w: SIZE.w, h: 20 }, 0)).toBeGreaterThan(100);
  }, 180_000);

  it("publishes nothing when the video fails QA", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 2, base: grey(2), now: { 1: RED } }]);
    const failQa = async (files: string[]): Promise<QaReport[]> =>
      files.map((target) => ({ ok: !target.endsWith(".mp4"), target, checks: [{ check: "video:loudness", ok: !target.endsWith(".mp4"), details: "-40 LUFS", problems: target.endsWith(".mp4") ? ["integrated loudness -40 LUFS"] : [] }] }));
    const r = await buildReleaseVideo(options(f, { qa: failQa }));
    expect(r.status).toBe("qa-failed");
    expect(r.ok).toBe(false);
    expect(r.block).toBeUndefined();
    expect(r.qa).toMatchObject({ ok: false, problems: ["video:loudness: integrated loudness -40 LUFS"] });
    expect(existsSync(join(releaseVideoPaths(f.config).publicDir!, "whats-new.mp4"))).toBe(false);
    expect(JSON.parse(readFileSync(r.qa!.file, "utf8")).ok).toBe(false);
  }, 180_000);

  it("passes the real QA gates (loudness, black frames, captions, transcript, personal data)", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 2, base: grey(2), now: { 1: RED } }]);
    const r = await buildReleaseVideo(options(f, { qa: undefined }));
    expect(r.qa?.problems).toEqual([]);
    expect(r.status).toBe("written");
  }, 240_000);
});

describe("the What's new page block", () => {
  it("is byte-identical on a rebuild with no change, and keeps human edits", async () => {
    const f = await makeFixture(APP);
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "a1\x1f2026-11-01T00:00:00+00:00\x1fAdd an export button (#3)", stderr: "" });
    const page = async (extra: Partial<BuildReleaseVideoOptions> = {}) => {
      const r = await buildReleaseVideo(options(f, extra));
      return buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, since: f.baseSha, runner, videoBlock: r.block });
    };

    const first = await page();
    const text1 = readFileSync(first.pageFile, "utf8");
    expect(text1.indexOf("aida:begin whats-new-video")).toBeLessThan(text1.indexOf("aida:begin whats-new */"));
    const second = await page();
    expect(readFileSync(second.pageFile, "utf8")).toBe(text1);

    // A person's note outside the blocks, and their rewording inside the video block, survive a
    // --video rerun and a plain rerun alike.
    const edited = text1
      .replace("{/* aida:begin whats-new-video */}", "A note from the team.\n\n{/* aida:begin whats-new-video */}")
      .replace("In this video:", "This release covers:");
    writeFileSync(first.pageFile, edited);
    await page();
    expect(readFileSync(first.pageFile, "utf8")).toBe(edited);
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, since: f.baseSha, runner });
    expect(readFileSync(first.pageFile, "utf8")).toBe(edited);
  }, 240_000);

  it("a plain rerun leaves an untouched video block exactly as it was", async () => {
    const f = await makeFixture(APP);
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    const r = await buildReleaseVideo(options(f));
    const withVideo = await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner, videoBlock: r.block });
    const text = readFileSync(withVideo.pageFile, "utf8");
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner });
    expect(readFileSync(withVideo.pageFile, "utf8")).toBe(text);
    // And `null` (nothing changed) takes it off.
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner, videoBlock: null });
    expect(readFileSync(withVideo.pageFile, "utf8")).not.toContain("VideoEmbed");
  }, 180_000);
});

describe("aida whats-new --video", () => {
  it("--json reports the video's status, guides, what's missing and the build command", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 3, base: grey(3), now: { 2: RED }, noSegments: true }]);
    const configPath = join(f.root, "aida.config.mjs");
    writeFileSync(
      configPath,
      `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", outDir: "./dist", buildDir: "./.build", helpApp: "./help" };\n`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runWhatsNew({ configPath, video: true, base: f.baseSha, draft: true }, true);
      expect(code).toBe(1);
      const out = JSON.parse(log.mock.calls[0][0] as string);
      expect(out).toMatchObject({
        ok: false,
        pageFile: join(f.config.helpApp!, "content", "docs", "whats-new", "index.mdx"),
        video: {
          status: "missing-segments",
          ok: false,
          base: f.baseSha,
          guides: [],
          leftOut: [],
          excluded: [],
          missing: [{ id: "add-entry", step: 2, stepId: "step-2" }],
          buildCommand: "aida build add-entry --draft",
        },
      });
      expect(out.video).not.toHaveProperty("block");
    } finally {
      log.mockRestore();
    }
  }, 180_000);

  it("says so when there's no release to compare with", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 1, base: grey(1), noVideo: true }]);
    const configPath = join(f.root, "aida.config.mjs");
    writeFileSync(configPath, `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", outDir: "./dist", buildDir: "./.build", helpApp: "./help" };\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runWhatsNew({ configPath, video: true }, false)).toBe(1);
      expect(err.mock.calls.map((c) => c[0]).join("\n")).toContain("no release to compare with");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  }, 180_000);
});

describe("what the release video is cut from, and what happens to the one already published", () => {
  const ONE: GuideSpec[] = [{ id: "add-entry", title: "Add an entry", steps: 3, base: grey(3), now: { 2: RED } }];
  const staged = (f: Fixture) => join(releaseVideoPaths(f.config).publicDir!, "whats-new.mp4");
  /** A release video on the site, embedded on the What's new page, as `aida whats-new --video` leaves it. */
  const publish = async (f: Fixture) => {
    const r = await buildReleaseVideo(options(f));
    expect(r.status).toBe("written");
    const { runner } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner, videoBlock: r.block });
  };

  it("writes a manifest of the guides, walkthroughs and scenes beside the staged video", async () => {
    const f = await makeFixture(ONE);
    const r = await buildReleaseVideo(options(f));
    expect(r.status).toBe("written");
    const manifest = readReleaseManifest(f.config.helpApp!)!;
    expect(manifest.settings).toMatchObject({ fps: FPS, draft: true });
    expect(manifest.guides.map((g) => [g.id, g.scenes.map((s) => s.id)])).toEqual([["add-entry", ["step-2"]]]);
    expect(manifest.guides[0].walkthrough).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.guides[0].scenes[0].hash).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it("refuses a guide whose walkthrough changed since its last render, and takes the old video down", async () => {
    const f = await makeFixture(ONE);
    await publish(f);
    // A person retitles step 2 (or adds `blur:` to it) and runs this before `aida build`: the
    // file's words and the render's scenes would disagree.
    writeWalkthrough(f.config.walkthroughsDir, { ...ONE[0], stepTitle: (n) => (n === 2 ? "Fill in the form" : `Step ${n} of Add an entry`) });
    const r = await buildReleaseVideo(options(f));
    expect(r).toMatchObject({
      status: "stale-render",
      ok: false,
      stale: [{ id: "add-entry", reason: "its walkthrough changed since its last build" }],
      buildCommand: "aida build add-entry --draft",
      previous: { kept: false, reason: "add-entry's walkthrough changed since the video was made" },
      block: null,
    });
    expect(r.message).toContain("run `aida build add-entry --draft`");
    expect(r.message).toContain("taken down");
    expect(existsSync(staged(f))).toBe(false);
  }, 180_000);

  it("keeps an older video that's still true of its guides when a run can't publish a new one", async () => {
    const f = await makeFixture(ONE);
    await publish(f);
    const failQa = async (files: string[]): Promise<QaReport[]> => files.map((target) => ({ ok: false, target, checks: [{ check: "video:loudness", ok: false, details: "", problems: ["quiet"] }] }));
    const r = await buildReleaseVideo(options(f, { qa: failQa, release: "2.5" }));
    expect(r).toMatchObject({ status: "qa-failed", ok: false, previous: { kept: true } });
    expect(r.block).toBeUndefined();
    expect(r.message).toContain("the video already on the site stays");
    expect(existsSync(staged(f))).toBe(true);
  }, 180_000);

  it("only takes part while published right now: its page and its own video on the site", async () => {
    const f = await makeFixture([
      { id: "add-entry", title: "Add an entry", steps: 2, base: grey(2), now: { 1: RED } },
      // qa.json and pages-cache.json still say ok, but the last build took it off the site.
      { id: "unpublished", title: "Unpublished", steps: 2, base: grey(2), now: { 1: RED }, unpublished: true },
    ]);
    const r = await buildReleaseVideo(options(f));
    expect(r.guides.map((g) => g.id)).toEqual(["add-entry"]);
    expect(r.excluded).toEqual([{ id: "unpublished", reason: "its page isn't on the help site (the last build didn't publish it)" }]);
  }, 180_000);

  it("says it can't tell, not that nothing changed, when no guide can be checked", async () => {
    const f = await makeFixture(ONE);
    await publish(f);
    rmSync(f.config.buildDir, { recursive: true, force: true });
    const r = await buildReleaseVideo(options(f));
    expect(r).toMatchObject({
      status: "cant-tell",
      ok: false,
      buildCommand: "aida build --draft",
      // The video already there can't be vouched for either (its frames went with the build
      // folder), so it comes down, and the output says why.
      previous: { kept: false, reason: "add-entry's capture is gone, so its scenes can't be checked" },
      block: null,
    });
    expect(r.message).toContain("no guide is published to check");
    expect(r.message).toContain("taken down");
    expect(existsSync(staged(f))).toBe(false);
  }, 180_000);

  it("says it can't tell when every guide is undecided", async () => {
    const f = await makeFixture(ONE);
    const r = await buildReleaseVideo(options(f, { base: "v9.9.9" }));
    expect(r.status).toBe("cant-tell");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("can't tell whether 1 guide changed since v9.9.9");
    expect(r.excluded).toEqual([{ id: "add-entry", reason: "screenshots at v9.9.9 can't be read, and the impact map couldn't run" }]);
  }, 180_000);

  it("counts a reused segment shorter than planned as missing", async () => {
    const f = await makeFixture(ONE);
    const tl = f.timelines.get("add-entry")!;
    const [seg] = findSceneSegments(tl, ["step-2"], {
      assetsDir: join(f.config.outDir, "videos", "add-entry", ".compose"),
      segmentsDir: join(f.config.outDir, "videos", "add-entry", "segments", "draft"),
      quality: qualityFor(true, FPS),
      draft: true,
    });
    colourSegment(seg.file, Math.max(1, seg.end - seg.start - 3), "0x3060a0");
    const r = await buildReleaseVideo(options(f));
    expect(r).toMatchObject({ status: "missing-segments", missing: [{ id: "add-entry", step: 2, stepId: "step-2" }] });
  }, 180_000);

  it("refuses a cap that isn't a whole number, instead of switching it off", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 1, base: grey(1), noVideo: true }]);
    await expect(buildReleaseVideo(options(f, { maxGuides: Number.NaN }))).rejects.toThrow(RangeError);
    await expect(buildReleaseVideo(options(f, { maxStepsPerGuide: 0 }))).rejects.toThrow(/maxStepsPerGuide/);
    await expect(buildReleaseVideo(options(f, { maxSeconds: Number.NaN }))).rejects.toThrow(/maxSeconds/);
  });
});

describe("the video block follows the files", () => {
  const runner = () => createFakeCommandRunner({ code: 0, stdout: "", stderr: "" }).runner;

  it("rewrites a hand-edited block when the video changes, keeping only prose that can't point at anything gone", async () => {
    const f = await makeFixture(APP);
    const page = async (extra: Partial<BuildReleaseVideoOptions> = {}) => {
      const r = await buildReleaseVideo(options(f, extra));
      return buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner: runner(), videoBlock: r.block });
    };
    const first = await page();
    const text = readFileSync(first.pageFile, "utf8")
      .replace("In this video:", "This release covers:")
      .replace("{/* aida:end whats-new-video */}", "\nWatch it before the team meeting.\n{/* aida:end whats-new-video */}");
    writeFileSync(first.pageFile, text);

    // A different video (one guide only): the old list goes, the embed is the new one, and the
    // person's free-standing sentence stays.
    const second = await page({ maxGuides: 1 });
    const after = readFileSync(second.pageFile, "utf8");
    expect(after).not.toContain("This release covers:");
    expect(after).toContain("In this video: [Add an entry](/how-do-i/add-entry) (steps 2 and 3).");
    expect(after).toContain("Watch it before the team meeting.");
    expect(after).toContain('<VideoEmbed src={"/videos/_whats-new/whats-new.mp4"}');
    expect(second.suggestions.map((s) => s.message).join("\n")).toContain("the release video changed");
  }, 240_000);

  it("removes a hand-edited block when there's no video any more, on a --video run or a plain one", async () => {
    const f = await makeFixture(APP);
    const r = await buildReleaseVideo(options(f));
    const first = await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner: runner(), videoBlock: r.block });
    writeFileSync(first.pageFile, readFileSync(first.pageFile, "utf8").replace("In this video:", "This release covers:"));
    // "Nothing changed": the block goes even though a person edited it.
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner: runner(), videoBlock: null });
    expect(readFileSync(first.pageFile, "utf8")).not.toContain("VideoEmbed");

    // A plain run with the files gone (taken down by a build) drops the embed too.
    const again = await buildReleaseVideo(options(f));
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner: runner(), videoBlock: again.block });
    expect(readFileSync(first.pageFile, "utf8")).toContain("VideoEmbed");
    rmSync(join(releaseVideoPaths(f.config).publicDir!, "whats-new.mp4"));
    await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner: runner() });
    expect(readFileSync(first.pageFile, "utf8")).not.toContain("VideoEmbed");
  }, 240_000);
});

describe("the words say what's true", () => {
  const urls = releaseVideoPaths({ outDir: "/out", helpApp: "/help" }).urls;
  const guide = (extra: Partial<ReleaseGuideText>): ReleaseGuideText => ({
    id: "add-entry",
    title: "Add an entry",
    rule: "new",
    steps: [{ n: 1, title: "One", say: "One." }],
    stepCount: 2,
    href: "/how-do-i/add-entry",
    ...extra,
  });

  it("calls a guide new only when its walkthrough is, and names a rename", () => {
    expect(guideCard(guide({ newKind: "guide" }))).toMatchObject({ eyebrow: "New guide", say: "New guide: Add an entry." });
    expect(guideCard(guide({ newKind: "published" }))).toMatchObject({ eyebrow: "Now on the help site", say: "Now on the help site: Add an entry." });
    expect(guideCard(guide({ rule: "screenshots", renamedFrom: "Add a record" }))).toMatchObject({
      subtitle: 'Step 1; was "Add a record"',
      say: "Add an entry, renamed from Add a record: step 1 changed.",
    });
    expect(openingCard("2.4", "2.4", 2, 2).say).toBe("What's new in 2.4: 2 guides changed.");
    expect(openingCard("2.4", "2.4", 2, 5)).toMatchObject({ subtitle: "5 guides changed, 2 in this video", say: "What's new in 2.4: 5 guides changed; this video shows 2 of them." });
  });

  it("gives each left-out guide its real reason", () => {
    const left = (title: string, why: "short" | "shape" | "device") => ({ title, href: `/how-do-i/${title.toLowerCase()}`, steps: [2], partly: false, why });
    const block = videoBlock("What's new: 2.4", urls, [guide({ newKind: "guide" })], [left("Short", "short"), left("Phone", "shape"), left("Tablet", "device")]);
    expect(block.content).toContain("Also changed, left out to keep the video short: [Short](/how-do-i/short) (step 2).");
    expect(block.content).toContain("Also changed, not in this video because its video is a different shape (phone or desktop): [Phone](/how-do-i/phone) (step 2).");
    expect(block.content).toContain("Also changed, on steps this video doesn't show (they're for another device): [Tablet](/how-do-i/tablet) (step 2).");
  });
});

describe("refs never reach git as options", () => {
  it("refuses a --base or --since that starts with a dash, before any git call", async () => {
    const f = await makeFixture([{ id: "add-entry", title: "Add an entry", steps: 1, base: grey(1), noVideo: true }]);
    const configPath = join(f.root, "aida.config.mjs");
    writeFileSync(configPath, `export default { app: { baseUrl: "http://localhost:3000" }, walkthroughsDir: "./walkthroughs", outDir: "./dist", buildDir: "./.build", helpApp: "./help" };\n`);
    const out = join(f.root, "injected");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runWhatsNew({ configPath, video: true, base: `--output=${out}` }, true)).toBe(1);
      expect(JSON.parse(log.mock.calls[0][0] as string).error).toBe(`--base "--output=${out}" can't be a git ref`);
      expect(await runWhatsNew({ configPath, since: `--output=${out}` }, true)).toBe(1);
      expect(existsSync(out)).toBe(false);
    } finally {
      log.mockRestore();
    }
  }, 60_000);
});
