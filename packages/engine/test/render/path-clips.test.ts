// M35: a short narrated clip per walkthrough path — opening steps from the path's own capture with
// the main video's player, brand, style and blur rules (blur unioned per screen across main + every
// path), then "Then continue from step N: <title>". Fictional Acme bookings app.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { pathClipFiles, pathClipLinks, renderPathClips, taskRouteBlur } from "../../src/render/clips.js";
import { pathClipLines, pathClipText } from "../../src/render/clip-lines.js";
import { buildTimeline, UNKNOWN_ROUTE } from "../../src/render/timeline.js";
import type { NarrationBeat, Timeline } from "../../src/render/types.js";
import { qualityFor } from "../../src/render/video.js";
import { NEUTRAL_COLORS, type ArtifactBrand } from "../../src/render/brand.js";

const brand = (style: ArtifactBrand["style"]): ArtifactBrand => ({ colors: { ...NEUTRAL_COLORS }, configured: false, style } as ArtifactBrand);
import { buildPage } from "../../src/pages/build.js";
import { pdfInputFromPage, stripPathClips } from "../../src/pdf/input.js";
import { buildPageHtml, pathHeadingAnchors } from "../../src/pdf/html.js";
import { qrSvg } from "../../src/pdf/qr.js";

const SLOW = process.env.AIDA_TEST_SLOW === "1";

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A mid-grey PNG with a coloured band, so QA's black-frame and colour-range checks have real
 * pixels to look at. */
function png(width: number, height: number, hue: [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = y > height * 0.3 && y < height * 0.5;
      img.data[i] = band ? hue[0] : 200 - Math.round((x / width) * 60);
      img.data[i + 1] = band ? hue[1] : 205;
      img.data[i + 2] = band ? hue[2] : 210;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

function walkthrough(): Walkthrough {
  return {
    walkthrough: "record-payment",
    title: "Record a payment",
    product: "Acme Bookings",
    start: { page: "/bookings/12", signed_in_as: "staff", persona: { role: "staff" } },
    intro: { say: "Record a payment." },
    outro: { say: "Done." },
    steps: [
      { id: "open", title: "Open the payment form", say: "Select Record payment.", page_text: "Select **Record payment**.", actions: [] },
      { id: "save", title: "Save the payment", say: "Select Save.", page_text: "Select **Save**.", actions: [] },
    ],
    paths: [
      {
        id: "from-attendee",
        title: "From the attendee's page",
        when: "Use this when the attendee pays for several bookings at once.",
        start: { page: "/attendees/7" },
        steps: [
          {
            id: "open-attendee",
            title: "Open the attendee's payments",
            say: "On the attendee's page, select Pay.",
            page_text: "Select **Pay for attendee**.",
            blur: [{ id: "email", box: { x: 40, y: 40, w: 200, h: 30 } }],
            actions: [],
          },
        ],
        joins: "save",
      },
    ],
  };
}

function mstep(id: string, image: string, url: string, blur?: { id: string; box: { x: number; y: number; w: number; h: number } }[]): ManifestStep {
  return {
    id,
    camera: "full",
    cameraBox: null,
    events: [
      { type: "frame", image, transition: "cut" },
      { type: "move", to: { x: 660, y: 320 } },
      { type: "highlight", box: { x: 600, y: 300, w: 120, h: 40 } },
      { type: "click", at: { x: 660, y: 320 } },
      { type: "clearHighlight" },
    ],
    doc: { image, highlights: [{ x: 600, y: 300, w: 120, h: 40 }], ...(blur ? { blur } : {}) },
    impact: { urls: [url], requests: [] },
    checks: [],
  };
}

const VIEWPORT = { width: 960, height: 540 };

function writeRun(dir: string, steps: ManifestStep[], ok = true): CaptureManifest {
  mkdirSync(join(dir, "frames"), { recursive: true });
  steps.forEach((s, i) => writeFileSync(join(dir, "frames", s.doc.image!), png(VIEWPORT.width, VIEWPORT.height, i % 2 ? [30, 90, 200] : [220, 120, 40])));
  const manifest: CaptureManifest = { workflow: "record-payment", baseUrl: "http://127.0.0.1:3100", viewport: VIEWPORT, deviceScaleFactor: 1, steps };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "record-payment",
    ranAt: "2026-10-27T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok,
    steps: steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok, ms: 1 })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
  return manifest;
}

const BLUR = [{ id: "email", box: { x: 40, y: 40, w: 200, h: 30 } }];

function capture(opts: { pathOk?: boolean } = {}): { dir: string; main: CaptureManifest } {
  const dir = tmpDir("aida-clip-capture-");
  const main = writeRun(dir, [mstep("open", "m1.png", "/bookings/12"), mstep("save", "m2.png", "/payments/new")]);
  // The path's opening step has blur on /attendees/7; its shared "save" step is on /payments/new.
  writeRun(join(dir, "paths", "from-attendee"), [mstep("open-attendee", "p1.png", "/attendees/7", BLUR), mstep("save", "p2.png", "/payments/new")], opts.pathOk ?? true);
  return { dir, main };
}

function narration(audioPath = "/tmp/none.wav", ms = 900): Record<string, NarrationBeat> {
  const b = { audioPath, durationMs: ms };
  return {
    intro: b,
    open: b,
    save: b,
    outro: b,
    "from-attendee/intro": b,
    "from-attendee/open-attendee": b,
    "from-attendee/outro": b,
  };
}

describe("pathClipText", () => {
  it("names the way in and points back to the joined step", () => {
    const t = pathClipText(walkthrough(), walkthrough().paths![0]);
    expect(t.intro).toMatchObject({ eyebrow: "Another way", title: "From the attendee's page", subtitle: "Use this when the attendee pays for several bookings at once." });
    expect(t.outro).toEqual({ title: "Then continue from step 2: Save the payment", say: "Then continue from step 2: Save the payment." });
    expect(t.continueAt).toEqual({ step: 2, stepId: "save", title: "Save the payment" });
  });

  it("ends a path that runs to its own end on a Done card, pointing nowhere (decision 37)", () => {
    const wf = walkthrough();
    const { joins: _joins, ...alone } = wf.paths![0];
    wf.paths = [alone];
    const t = pathClipText(wf, alone);
    expect(t.outro).toEqual({ title: "Done", say: "Done." });
    expect(t.continueAt).toBeUndefined();
    expect(pathClipLines(wf).at(-1)).toEqual({ id: "from-attendee/outro", text: "Done." });
  });
});

describe("blur across the task's captures", () => {
  it("unions boxes per screen across main + paths: a path's blurred screen is blurred in the main video when it shows the same route", () => {
    const wf = walkthrough();
    const { dir, main } = capture();
    // The main video visits /attendees/7 too (its "open" step lands there): the path's box applies.
    main.steps[0].impact = { urls: ["/attendees/7"], requests: [] };
    const shared = taskRouteBlur(wf, main, dir);
    expect(shared.boxes.get("/attendees/:id")).toEqual([BLUR[0].box]);
    const tl = buildTimeline(wf, main, narration(), { fps: 15, sharedBlur: shared });
    expect(tl.blur?.length).toBeGreaterThan(0);
    expect(tl.blur?.[0].boxes).toContainEqual(BLUR[0].box);
    // Without the union (the M34 behaviour) the main video had no blur at all.
    expect(buildTimeline(wf, main, narration(), { fps: 15 }).blur).toEqual([]);
  });

  it("carries across runs that open different records: ids and slugs (M35 review)", () => {
    const wf = walkthrough();
    for (const [mainUrl, pathUrl] of [
      ["/attendees/3f1c2b9a-0d4e-4c1a-9b7e-2a6f8e1d5c40", "/attendees/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"],
      ["/attendees/spring-gala", "/attendees/autumn-fair"],
      ["/attendees/spring-gala/pay", "/attendees/autumn-fair/pay"],
    ]) {
      const { dir, main } = capture();
      const pathDir = join(dir, "paths", "from-attendee");
      const pathManifest = JSON.parse(readFileSync(join(pathDir, "manifest.json"), "utf8")) as CaptureManifest;
      pathManifest.steps[0].impact = { urls: [pathUrl], requests: [] };
      writeFileSync(join(pathDir, "manifest.json"), JSON.stringify(pathManifest));
      main.steps[0].impact = { urls: [mainUrl], requests: [] };
      const tl = buildTimeline(wf, main, narration(), { fps: 15, sharedBlur: taskRouteBlur(wf, main, dir) });
      expect(tl.blur?.[0]?.boxes, `${mainUrl} vs ${pathUrl}`).toContainEqual(BLUR[0].box);
    }
  });

  it("applies a box from a screen no capture could name to every screen", () => {
    const wf = walkthrough();
    const { main } = capture();
    const shared = { boxes: new Map([[UNKNOWN_ROUTE, [BLUR[0].box]]]), scrolled: new Set<string>() };
    const tl = buildTimeline(wf, main, narration(), { fps: 15, sharedBlur: shared });
    expect(tl.blur?.map((w) => w.boxes)).toEqual([[BLUR[0].box], [BLUR[0].box]]);
  });

  it("leaves screens no capture blurred alone", () => {
    const wf = walkthrough();
    const { dir, main } = capture();
    const tl = buildTimeline(wf, main, narration(), { fps: 15, sharedBlur: taskRouteBlur(wf, main, dir) });
    expect(tl.blur).toEqual([]); // main never shows /attendees/7
  });
});

/** Runs `renderPathClips` with a stand-in encoder that records each timeline. */
async function clipsWith(wf: Walkthrough, captureDir: string, main: CaptureManifest, beats = narration()) {
  const outDir = tmpDir("aida-clip-out-");
  const encoded: { tl: Timeline; files: { mp4: string } }[] = [];
  const quality = qualityFor(true, 15);
  const mainTl = buildTimeline(wf, main, beats, { fps: 15 });
  const results = await renderPathClips(wf, mainTl, {
    options: { outDir, captureDir, narration: beats, draft: true, brand: brand("minimal") },
    quality,
    draft: true,
    outDir,
    sharedBlur: taskRouteBlur(wf, main, captureDir),
    encode: async (tl, files) => {
      encoded.push({ tl, files });
      writeFileSync(files.mp4, "fake");
      return { skipped: false, wallTimeMs: 0 };
    },
  });
  return { results, encoded, outDir, mainTl };
}

describe("renderPathClips", () => {
  it("builds the clip from the path's opening steps and frames, with a title card and a closing card", async () => {
    const wf = walkthrough();
    const { dir, main } = capture();
    const { results, encoded, outDir, mainTl } = await clipsWith(wf, dir, main);
    expect(results).toHaveLength(1);
    const [clip] = results;
    expect(clip.mp4).toBe(join(outDir, "record-payment.path-from-attendee.mp4"));
    expect(clip.srt).toBe(join(outDir, "record-payment.path-from-attendee.srt"));
    expect(clip.continueAt).toEqual({ step: 2, stepId: "save", title: "Save the payment", t: Number(mainTl.scenes!.find((s) => s.id === "save")!.t0.toFixed(2)) });

    const tl = encoded[0].tl;
    expect(tl.scenes?.map((s) => s.id)).toEqual(["intro", "open-attendee", "outro"]);
    expect(tl.frames.every((f) => f.src.startsWith(join(dir, "paths", "from-attendee", "frames")))).toBe(true);
    expect(tl.intro).toMatchObject({ eyebrow: "Another way", titleHtml: "From the attendee's page", facts: ["1 step", "then step 2"] });
    expect(tl.outro.title).toBe("Then continue from step 2: Save the payment");
    expect(tl.captions.map((c) => c.text)).toEqual(["Another way: From the attendee's page.", "On the attendee's page, select Pay.", "Then continue from step 2: Save the payment."]);
    expect(tl.chips[0]).toMatchObject({ title: "Open the attendee's payments", eyebrow: "Step 1 of 1" });
    // Same brand/style rules: the minimal preset's card schedule, no hero (blur declared).
    expect(tl.cards?.intro.some((r) => r.id === "intro-hero")).toBe(false);
    // Blur from frame 0 to the end (first and last windows stretch), on the path's own screen.
    expect(tl.blur?.[0]).toMatchObject({ t0: 0, t1: tl.duration });
    expect(tl.blur?.[0].boxes).toContainEqual(BLUR[0].box);
    // Shorter title card than the main video's 5.5 s minimum.
    expect(tl.scenes![0].t1).toBeLessThan(5.5);
  });

  it("has no clip for a path whose capture failed, or with no narration yet, and removes an old one", async () => {
    const wf = walkthrough();
    const failed = capture({ pathOk: false });
    const r1 = await clipsWith(wf, failed.dir, failed.main);
    expect(r1.results[0]).toMatchObject({ skipped: true, notRendered: expect.stringMatching(/capture didn't pass/) });
    expect(r1.encoded).toHaveLength(0);

    const ok = capture();
    const beats = narration();
    delete beats["from-attendee/outro"];
    const r2 = await clipsWith(wf, ok.dir, ok.main, beats);
    expect(r2.results[0].notRendered).toMatch(/narration for "from-attendee\/outro" is missing/);
  });

  it("prunes clips of paths the walkthrough no longer has", async () => {
    const wf = walkthrough();
    const { dir, main } = capture();
    const { outDir } = await clipsWith(wf, dir, main);
    const stale = join(outDir, "record-payment.path-gone.mp4");
    writeFileSync(stale, "old");
    await renderPathClips(wf, buildTimeline(wf, main, narration(), { fps: 15 }), {
      options: { outDir, captureDir: dir, narration: narration() },
      quality: qualityFor(true, 15),
      draft: true,
      outDir,
      sharedBlur: taskRouteBlur(wf, main, dir),
      encode: async () => ({ skipped: true, wallTimeMs: 0 }),
    });
    expect(existsSync(stale)).toBe(false);
  });
});

describe("pages and PDFs", { timeout: 60_000 }, () => {
  function videoDirWithClip(): string {
    const videoDir = tmpDir("aida-clip-videos-");
    const d = join(videoDir, "record-payment");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "record-payment.mp4"), "main");
    writeFileSync(join(d, "timeline.json"), JSON.stringify({ scenes: [{ id: "intro", t0: 0 }, { id: "open", t0: 5.5 }, { id: "save", t0: 42.31 }] }));
    const files = pathClipFiles(d, "record-payment", "from-attendee");
    writeFileSync(files.mp4, "clip");
    writeFileSync(files.vtt, "WEBVTT\n");
    return videoDir;
  }

  it("pathClipLinks gives site URLs and the main video's chapter time", () => {
    expect(pathClipLinks(videoDirWithClip(), walkthrough())).toEqual([
      {
        pathId: "from-attendee",
        src: "/videos/record-payment/record-payment.path-from-attendee.mp4",
        vtt: "/videos/record-payment/record-payment.path-from-attendee.vtt",
        continueAt: { step: 2, title: "Save the payment", t: 42.31 },
        mainVideoAt: "/videos/record-payment/record-payment.mp4#t=42.31",
      },
    ]);
  });

  it("embeds each path's clip under its heading; the PDF keeps crops and adds a QR only with a site URL", async () => {
    const { dir } = capture();
    const result = await buildPage(walkthrough(), dir, tmpDir("aida-clip-pages-"), { videoDir: videoDirWithClip() });
    const mdx = readFileSync(result.indexFile, "utf8");
    const section = mdx.slice(mdx.indexOf("### From the attendee's page"));
    expect(section).toContain(
      '<VideoEmbed src={"/videos/record-payment/record-payment.path-from-attendee.mp4"} vtt={"/videos/record-payment/record-payment.path-from-attendee.vtt"} title={"From the attendee\'s page"} />',
    );
    expect(section).toContain("Watch the rest from [step 2 in the main video (0:42)](/videos/record-payment/record-payment.mp4#t=42.31).");
    expect(section.indexOf("<VideoEmbed")).toBeLessThan(section.indexOf("#### 1."));

    const input = pdfInputFromPage(walkthrough(), result);
    expect(input.pathClips).toEqual(["from-attendee"]);
    expect(input.markdown).not.toContain("VideoEmbed");
    expect(input.markdown).not.toContain("Watch the rest");
    const plain = buildPageHtml(input);
    expect(plain).not.toContain("aida-path-clip");
    expect(plain).not.toContain('class="path-qr"');
    expect(plain).toContain("paths/from-attendee/step-01"); // the path's crop is still printed
    const withSite = buildPageHtml(input, undefined, false, { siteUrl: "https://help.example.com" });
    expect(withSite).toContain('<div class="path-qr"><svg class="qr"');
    expect(withSite).toContain("<title>Watch this way online</title>");
  });

  it("links the QR to the path's heading id as the site numbers it, -1 for a repeat (M35 review)", async () => {
    const md = "# Steps\n\n## Steps\n\n#### 1. Open\n\n## Other ways to do this\n\n### Steps\n\nwhen\n\n### From the attendee's page\n\nwhen\n";
    expect(pathHeadingAnchors(md)).toEqual(["steps-2", "from-the-attendees-page"]);
    const wf = walkthrough();
    wf.paths![0].title = "Steps";
    const { dir } = capture();
    const result = await buildPage(wf, dir, tmpDir("aida-clip-pages-"), { videoDir: videoDirWithClip() });
    const input = pdfInputFromPage(wf, result);
    const anchors = pathHeadingAnchors(input.markdown);
    expect(anchors).toEqual(["steps-1"]); // the page's own "## Steps" heading is "steps"
    const html = buildPageHtml(input, undefined, false, { siteUrl: "https://help.example.com" });
    const url = `https://help.example.com/${input.sitePath!.replace(/^\//, "")}#steps-1`;
    expect(html).toContain(qrSvg(url, { label: "Watch this way online" }));
  });

  it("strips a clip block whatever the title holds", () => {
    const md = `### P\n\nwhen\n\n<VideoEmbed src={"/videos/a/a.path-p-1.mp4"} title={"Say \\"hi\\" {x}"} />\n\nWatch the rest from [step 3 in the main video (1:02)](/videos/a/a.mp4#t=62).\n\n#### 1. B\n`;
    const out = stripPathClips(md);
    expect(out.pathClips).toEqual(["p-1"]);
    expect(out.markdown).toBe("### P\n\nwhen\n\n@@aida-path-clip:p-1@@\n\n#### 1. B\n");
  });
});

// Real render (AIDA_TEST_SLOW=1, `npm run test:slow`): main video + the path's clip through the
// real player and ffmpeg, then QA's video and caption gates on the clip.
describe.skipIf(!SLOW)("render: path clips end to end", () => {
  it(
    "writes <id>.path-<pathId>.mp4 + .srt/.vtt next to the main video, reuses it from cache, and passes QA",
    async () => {
      const { render } = await import("../../src/render/index.js");
      const { runQa } = await import("../../src/qa/run.js");
      const wf = walkthrough();
      const { dir } = capture();
      const voiceDir = tmpDir("aida-clip-voice-");
      const wav = join(voiceDir, "tone.wav");
      // A speech-like tone: QA's loudness gate needs real audio.
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-af", "volume=0.5", wav]);
      const beats = narration(wav, 3000);
      const outDir = tmpDir("aida-clip-render-");
      const result = await render(wf, { outDir, captureDir: dir, narration: beats, draft: true, fps: 10, brand: brand("friendly"), concurrency: 2 });
      const clip = result.clips?.[0];
      expect(clip?.mp4).toBe(join(outDir, "record-payment", "record-payment.path-from-attendee.mp4"));
      for (const f of [clip!.mp4!, clip!.srt!, clip!.vtt!]) expect(existsSync(f)).toBe(true);
      expect(statSync(clip!.mp4!).size).toBeGreaterThan(10_000);
      expect(readFileSync(clip!.vtt!, "utf8").replace(/\s+/g, " ")).toContain("Then continue from step 2: Save the payment.");
      expect(clip!.durationSec).toBeLessThan(result.durationSec);
      // eslint-disable-next-line no-console
      console.log(`[path clip] ${clip!.mp4} ${statSync(clip!.mp4!).size} bytes, ${clip!.durationSec}s (main ${result.durationSec}s, ${statSync(result.mp4!).size} bytes)`);

      const again = await render(wf, { outDir, captureDir: dir, narration: beats, draft: true, fps: 10, brand: brand("friendly") });
      expect(again.skipped).toBe(true);
      expect(again.clips?.[0].skipped).toBe(true);

      for (const target of [clip!.mp4!, clip!.vtt!]) {
        const report = await runQa(target);
        const failed = report.checks.filter((c) => !c.ok);
        expect(failed, JSON.stringify(failed)).toEqual([]);
      }
    },
    600_000,
  );
});
