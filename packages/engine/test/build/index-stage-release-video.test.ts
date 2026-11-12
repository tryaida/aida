// The build's index stage takes the release video (M48) down, with its page block, once any guide
// in it is no longer what was cut: deleted, unpublished, its walkthrough edited, or its scene
// rendered again (a blur box added). And the QA stage never leaves an older passing `qa.json`
// behind a QA run that couldn't say ok, so the release video's publishable gate agrees with it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndexStage } from "../../src/build/index-stage.js";
import { runPipeline } from "../../src/build/pipeline.js";
import type { ResolvedConfig } from "../../src/config/index.js";
import { createFakeCommandRunner } from "../../src/publish/index.js";
import type { QaReport } from "../../src/qa/run.js";
import type { Timeline } from "../../src/render/types.js";
import { loadWalkthroughFile } from "../../src/walkthrough/loader.js";
import { buildWhatsNew } from "../../src/whats-new/build.js";
import { buildReleaseVideo, releaseVideoPaths } from "../../src/whats-new/release-video.js";
import { cleanupTmpDirs, tmpDir } from "../ci/helpers.js";
import { FPS, fakeCardRenderer, makeFixture, writeWalkthrough, type Fixture, type GuideSpec } from "../whats-new/release-fixture.js";

afterEach(() => cleanupTmpDirs());

const GREY: [number, number, number] = [200, 200, 200];
const RED: [number, number, number] = [220, 30, 30];
const APP: GuideSpec[] = [
  { id: "add-entry", title: "Add an entry", steps: 2, base: { 1: GREY, 2: GREY }, now: { 2: RED } },
  { id: "pay-invoice", title: "Pay an invoice", steps: 2, base: { 1: GREY, 2: GREY } },
];
const passQa = async (files: string[]): Promise<QaReport[]> => files.map((target) => ({ ok: true, target, checks: [] }));

/** A published release video of `add-entry`, and its block on the What's new page. */
async function published(): Promise<Fixture> {
  const f = await makeFixture(APP);
  const r = await buildReleaseVideo({
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
  });
  expect(r.status).toBe("written");
  const { runner } = createFakeCommandRunner({ code: 0, stdout: "", stderr: "" });
  await buildWhatsNew({ appRepo: f.root, helpApp: f.config.helpApp!, runner, videoBlock: r.block });
  return f;
}

/** The index stage as the build runs it, over the pages already staged. */
function indexStage(f: Fixture, ids = APP.map((g) => g.id)) {
  const walkthroughs = ids.map((id) => loadWalkthroughFile(join(f.config.walkthroughsDir, `${id}.yaml`)));
  return runIndexStage({
    pagesDir: join(f.config.outDir, "pages"),
    outDir: f.config.outDir,
    helpApp: f.config.helpApp,
    pages: [],
    walkthroughIds: ids,
    walkthroughs,
    videoDir: join(f.config.outDir, "videos"),
  });
}

const videoUp = (f: Fixture) => existsSync(join(releaseVideoPaths(f.config).publicDir!, "whats-new.mp4"));
const pageText = (f: Fixture) => readFileSync(join(f.config.helpApp!, "content", "docs", "whats-new", "index.mdx"), "utf8");

describe("runIndexStage and the release video", () => {
  it("leaves the video and its block up while every guide in it is as it was cut", async () => {
    const f = await published();
    indexStage(f);
    expect(videoUp(f)).toBe(true);
    expect(pageText(f)).toContain("VideoEmbed");
  }, 180_000);

  it("takes it down when a guide's scene is rendered again with a blur box", async () => {
    const f = await published();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // `aida build` after a `blur:` was added: step 2's scene now burns in a box.
      const file = join(f.config.outDir, "videos", "add-entry", "timeline.json");
      const tl = JSON.parse(readFileSync(file, "utf8")) as Timeline;
      const scene = tl.scenes!.find((s) => s.id === "step-2")!;
      tl.blur = [{ t0: scene.t0, t1: scene.t1, boxes: [{ x: 10, y: 10, w: 100, h: 40 }] }];
      writeFileSync(file, JSON.stringify(tl));
      indexStage(f);
      expect(videoUp(f)).toBe(false);
      expect(existsSync(join(releaseVideoPaths(f.config).publicDir!, "whats-new.manifest.json"))).toBe(false);
      expect(pageText(f)).not.toContain("VideoEmbed");
      expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("add-entry's video changed since (step step-2)");
    } finally {
      warn.mockRestore();
    }
  }, 180_000);

  it("takes it down when a guide's walkthrough is edited, and when one is deleted", async () => {
    const f = await published();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWalkthrough(f.config.walkthroughsDir, { ...APP[0], stepTitle: (n) => `Updated step ${n}` });
      indexStage(f);
      expect(videoUp(f)).toBe(false);

      const g = await published();
      rmSync(join(g.config.walkthroughsDir, "add-entry.yaml"));
      indexStage(g, ["pay-invoice"]);
      expect(videoUp(g)).toBe(false);
      expect(pageText(g)).not.toContain("VideoEmbed");
    } finally {
      warn.mockRestore();
    }
  }, 240_000);

  it("takes it down when a guide is no longer published, and never throws into the build", async () => {
    const f = await published();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The guide's own video is gone from the render dir, so the index stage unpublishes it.
      rmSync(join(f.config.outDir, "videos", "add-entry", "add-entry.mp4"));
      expect(() => indexStage(f)).not.toThrow();
      expect(videoUp(f)).toBe(false);
      expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("add-entry is no longer published");
    } finally {
      warn.mockRestore();
    }
  }, 180_000);
});

describe("the build's QA stage", () => {
  it("replaces an older passing qa.json when this run had nothing to check", async () => {
    const root = tmpDir("m48-qa-stage-");
    const config = {
      app: { baseUrl: "http://localhost:3000" },
      walkthroughsDir: join(root, "walkthroughs"),
      outDir: join(root, "out"),
      buildDir: join(root, ".build"),
      configDir: root,
    } as ResolvedConfig;
    mkdirSync(config.walkthroughsDir, { recursive: true });
    writeFileSync(join(config.walkthroughsDir, "add-entry.yaml"), ["walkthrough: add-entry", 'title: "Add an entry"', "steps:", "  - id: only-step", '    title: "Do the thing"', '    say: "Do the thing."', ""].join("\n"));
    mkdirSync(join(config.buildDir, "add-entry"), { recursive: true });
    writeFileSync(join(config.buildDir, "add-entry", "qa.json"), JSON.stringify({ ok: true, reports: [] }));

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["qa"], json: false });
    expect(result.walkthroughs[0].stages.qa?.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(config.buildDir, "add-entry", "qa.json"), "utf8")).ok).toBe(false);
  }, 60_000);
});
