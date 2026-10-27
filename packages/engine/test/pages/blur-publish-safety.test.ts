// M22 review: "Prove no unblurred copy is published." Builds a real page (Playwright-rendered
// capture + buildPage's real annotateFrame) and a real PDF for a walkthrough whose one step has
// a blur box, then scans every file aida actually publishes (pageDir's screenshots, the
// procedures.json screenshot copy, and the PDF's own source input) for the raw capture frame's
// bytes — none should ever match. The PDF render itself (Playwright Chromium print) is slow, so
// it's gated behind AIDA_TEST_SLOW like the rest of pdf/test/integration.test.ts; the page +
// procedures checks (the actual leak this review caught) run every time.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";
import { buildProcedure } from "../../src/procedures/index.js";
import { pdfInputFromPage } from "../../src/pdf/input.js";
import { buildWalkthroughPdf, launchBrowser } from "../../src/pdf/build.js";
import { PNG } from "pngjs";

const SLOW = process.env.AIDA_TEST_SLOW === "1";
const VIEWPORT = { width: 200, height: 150 };

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A checkerboard PNG, like annotate.test.ts's — distinctive enough that "does this output file
 * contain the exact same bytes as the raw frame" is a meaningful, non-coincidental check. */
async function makeCheckerboardFrame(outPath: string): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize(VIEWPORT);
    const squares = Array.from({ length: 15 }, (_, row) =>
      Array.from({ length: 20 }, (_, col) => {
        const on = (row + col) % 2 === 0;
        return `<div style="position:absolute; left:${col * 10}px; top:${row * 10}px; width:10px; height:10px; background:${on ? "#000" : "#fff"};"></div>`;
      }).join(""),
    ).join("");
    await page.setContent(
      `<!doctype html><html><body style="margin:0; width:${VIEWPORT.width}px; height:${VIEWPORT.height}px; position:relative;">${squares}</body></html>`,
    );
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

function walkthroughWithBlur(): Walkthrough {
  return {
    walkthrough: "masked-flow",
    title: "A flow with something to hide",
    for: "office staff",
    start: { signed_in_as: "office-staff", page: "/accounts" },
    steps: [
      {
        id: "show-contact",
        title: "Contact details",
        page_text: "Their **contact details** are shown here.",
        blur: [{ id: "b1", box: { x: 20, y: 20, w: 100, h: 60 } }],
        actions: [],
      },
    ],
  };
}

/** Walks `dir` recursively, returning every file whose bytes exactly equal `needle` — the "is
 * the raw frame published anywhere under here" check. */
function findByteIdenticalFiles(dir: string, needle: Buffer): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...findByteIdenticalFiles(full, needle));
    else if (statSync(full).size === needle.length && readFileSync(full).equals(needle)) hits.push(full);
  }
  return hits;
}

describe("M22: a step's raw capture frame is never published when it has a blur box", () => {
  it("buildPage's own screenshot output never byte-matches the raw frame", async () => {
    const captureDir = tmpDir("aida-blursafe-capture-");
    const outDir = tmpDir("aida-blursafe-pages-");
    mkdirSync(join(captureDir, "frames"), { recursive: true });
    const framePath = join(captureDir, "frames", "0001-state.png");
    await makeCheckerboardFrame(framePath);
    const rawFrame = readFileSync(framePath);

    const manifest: CaptureManifest = {
      workflow: "masked-flow",
      baseUrl: "http://127.0.0.1:3100",
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      steps: [
        {
          id: "show-contact",
          camera: "full",
          cameraBox: null,
          events: [{ type: "frame", image: "0001-state.png", transition: "cut" }],
          doc: { image: "0001-state.png", highlights: [], blur: [{ id: "b1", box: { x: 20, y: 20, w: 100, h: 60 } }] },
          impact: { urls: [], requests: [] },
          checks: [],
        },
      ],
    };
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));
    const validation: ValidationResult = {
      workflow: "masked-flow",
      ranAt: "2026-10-25T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3100",
      ok: true,
      steps: [{ id: "show-contact", title: "Contact details", checks: [], ok: true, ms: 1 }],
      dbChecks: [],
      problems: { console: [], page: [], server: [] },
    };
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));

    const wf = walkthroughWithBlur();
    const result = await buildPage(wf, captureDir, outDir);
    expect(result.publishable).toBe(true);
    expect(result.screenshots.length).toBeGreaterThan(0);

    // The published screenshot itself must not be the raw frame.
    expect(findByteIdenticalFiles(outDir, rawFrame)).toEqual([]);

    // The procedures.json screenshot copy (the actual leak this review caught — it used to copy
    // straight from captureDir/frames, bypassing annotateFrame) must also not be the raw frame.
    const publicDir = tmpDir("aida-blursafe-public-");
    const pagesDir = outDir; // buildPage wrote directly into outDir/<id>, same as pagesDir convention
    const proc = buildProcedure(wf, captureDir, { publicDir, pagesDir });
    expect(proc?.steps[0].screenshot).toBeDefined();
    expect(findByteIdenticalFiles(publicDir, rawFrame)).toEqual([]);

    // The PDF module's own source input resolves screenshots from pages' output, never from
    // captureDir/frames directly — structurally, not just by this fixture's luck.
    const pdfInput = pdfInputFromPage(wf, result);
    for (const step of pdfInput.cardSteps) {
      if (!step.screenshot) continue;
      expect(step.screenshot.startsWith(captureDir)).toBe(false);
      expect(readFileSync(step.screenshot).equals(rawFrame)).toBe(false);
    }

    // M32: the print figures (clean full screen + focus crop) come from the same blurred render,
    // never from captureDir/frames — and none of them is the raw frame.
    expect(pdfInput.figures?.length).toBeGreaterThan(0);
    for (const fig of pdfInput.figures ?? []) {
      for (const file of [fig.full, fig.crop].filter((f): f is string => Boolean(f))) {
        expect(file.startsWith(join(captureDir, "frames"))).toBe(false);
        expect(readFileSync(file).equals(rawFrame)).toBe(false);
      }
    }
    expect(findByteIdenticalFiles(join(captureDir, "print"), rawFrame)).toEqual([]);
  }, 30_000);

  it.skipIf(!SLOW)(
    "a real PDF build for the same fixture never embeds the raw frame as a file alongside its output",
    async () => {
      const captureDir = tmpDir("aida-blursafe-capture-");
      const outDir = tmpDir("aida-blursafe-pages-");
      const pdfDir = tmpDir("aida-blursafe-pdf-");
      mkdirSync(join(captureDir, "frames"), { recursive: true });
      const framePath = join(captureDir, "frames", "0001-state.png");
      await makeCheckerboardFrame(framePath);
      const rawFrame = readFileSync(framePath);

      const manifest: CaptureManifest = {
        workflow: "masked-flow",
        baseUrl: "http://127.0.0.1:3100",
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        steps: [
          {
            id: "show-contact",
            camera: "full",
            cameraBox: null,
            events: [{ type: "frame", image: "0001-state.png", transition: "cut" }],
            doc: { image: "0001-state.png", highlights: [], blur: [{ id: "b1", box: { x: 20, y: 20, w: 100, h: 60 } }] },
            impact: { urls: [], requests: [] },
            checks: [],
          },
        ],
      };
      writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(
        join(captureDir, "validation.json"),
        JSON.stringify({
          workflow: "masked-flow",
          ranAt: "2026-10-25T00:00:00.000Z",
          baseUrl: "http://127.0.0.1:3100",
          ok: true,
          steps: [{ id: "show-contact", title: "Contact details", checks: [], ok: true, ms: 1 }],
          dbChecks: [],
          problems: { console: [], page: [], server: [] },
        } satisfies ValidationResult),
      );

      const wf = walkthroughWithBlur();
      const pageResult = await buildPage(wf, captureDir, outDir);
      const pdfInput = pdfInputFromPage(wf, pageResult);

      const browser = await launchBrowser();
      try {
        const built = await buildWalkthroughPdf(pdfInput, { pdfDir }, browser);
        expect(built.excluded).toBeFalsy();
        expect(existsSync(built.file)).toBe(true);
      } finally {
        await browser.close();
      }

      // The PDF dir itself must never end up with a stray copy of the raw frame sitting next to
      // the rendered PDFs (e.g. a debug/cache artifact) — belt and suspenders on top of the
      // structural check above.
      expect(findByteIdenticalFiles(pdfDir, rawFrame)).toEqual([]);
    },
    60_000,
  );

  // M32 review: print figures are rendered at full size with focus crops, so the blur must hold
  // at a realistic viewport (a tiny one never crops) — inside the box, in the full screen, the
  // crop and the site screenshot. And a step whose click opens another page must never fall back
  // to an earlier frame that shows what another step blurred, unblurred.
  it("print figures and site screenshots stay flat inside every blur box, crops included", async () => {
    const BIG = { width: 1200, height: 700 };
    const BLUR = { x: 500, y: 300, w: 200, h: 80 };
    const captureDir = tmpDir("aida-blursafe-capture-");
    const outDir = tmpDir("aida-blursafe-pages-");
    mkdirSync(join(captureDir, "frames"), { recursive: true });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: BIG });
      await page.setContent(`<body style="margin:0;width:${BIG.width}px;height:${BIG.height}px;background:repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0/20px 20px"></body>`);
      await page.screenshot({ path: join(captureDir, "frames", "0001-state.png") });
      await page.setContent(`<body style="margin:0;width:${BIG.width}px;height:${BIG.height}px;background:#f8fafc"></body>`);
      await page.screenshot({ path: join(captureDir, "frames", "0002-state.png") });
    } finally {
      await browser.close();
    }
    const manifest: CaptureManifest = {
      workflow: "masked-flow",
      baseUrl: "http://127.0.0.1:3100",
      viewport: BIG,
      deviceScaleFactor: 1,
      steps: [
        {
          id: "show-contact",
          camera: "full",
          cameraBox: null,
          events: [{ type: "frame", image: "0001-state.png", transition: "cut" }, { type: "highlight", box: { x: 760, y: 320, w: 60, h: 30 } }],
          doc: { image: "0001-state.png", highlights: [{ x: 760, y: 320, w: 60, h: 30 }], blur: [{ id: "b1", box: BLUR }] },
          impact: { urls: [], requests: [] },
          checks: [],
        },
        {
          // Hovered on the same (blurred) screen, then the click opened a new page.
          id: "open-next",
          camera: "full",
          cameraBox: null,
          events: [
            { type: "frame", image: "0001-state.png", transition: "cut" },
            { type: "highlight", box: { x: 600, y: 330, w: 80, h: 30 } },
            { type: "click", at: { x: 640, y: 345 } },
            { type: "frame", image: "0002-state.png", transition: "fade" },
          ],
          doc: { image: "0002-state.png", highlights: [{ x: 600, y: 330, w: 80, h: 30 }] },
          impact: { urls: ["/accounts/next"], requests: [] },
          checks: [],
        },
      ],
    };
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(captureDir, "validation.json"),
      JSON.stringify({
        workflow: "masked-flow",
        ranAt: "2026-10-25T00:00:00.000Z",
        baseUrl: "http://127.0.0.1:3100",
        ok: true,
        steps: manifest.steps.map((st) => ({ id: st.id, title: st.id, checks: [], ok: true, ms: 1 })),
        dbChecks: [],
        problems: { console: [], page: [], server: [] },
      } satisfies ValidationResult),
    );
    const wf: Walkthrough = {
      ...walkthroughWithBlur(),
      steps: [
        { id: "show-contact", title: "Contact details", page_text: "Their details.", blur: [{ id: "b1", box: BLUR }], actions: [] },
        { id: "open-next", title: "Open next", page_text: "Click **Next**.", actions: [] },
      ],
    };
    const result = await buildPage(wf, captureDir, outDir);
    const figs = result.printFigures!;
    expect(figs).toHaveLength(2);

    /** Max - min brightness over `box` (frame CSS px) in an image showing frame rect `frame`. */
    const spread = (file: string, box: typeof BLUR, frame = { x: 0, y: 0, w: BIG.width, h: BIG.height }, inset = 0): number => {
      const png = PNG.sync.read(readFileSync(file));
      const sx = png.width / frame.w, sy = png.height / frame.h;
      const x0 = Math.max(0, Math.ceil((box.x - frame.x + inset) * sx)), x1 = Math.min(png.width, Math.floor((box.x + box.w - frame.x - inset) * sx));
      const y0 = Math.max(0, Math.ceil((box.y - frame.y + inset) * sy)), y1 = Math.min(png.height, Math.floor((box.y + box.h - frame.y - inset) * sy));
      let lo = 255, hi = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        const v = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return x1 > x0 && y1 > y0 ? hi - lo : 0;
    };

    // Step 1: a focus crop exists and covers the blur box; every image is flat inside it — edges
    // included (no rounded corners or soft rim letting the checkerboard through).
    const one = figs[0];
    expect(one.crop && one.cropBox).toBeTruthy();
    expect(spread(one.full, BLUR)).toBeLessThanOrEqual(3);
    expect(spread(one.crop!, BLUR, one.cropBox!)).toBeLessThanOrEqual(3);
    expect(spread(join(result.screenshotsDir, "step-01.png"), BLUR, undefined, 1)).toBeLessThanOrEqual(3);

    // Step 2: its click opened a new page, but the hover frame shows step 1's blurred area raw —
    // so the planner must keep the new page (no frame swap) and nothing there shows the pattern.
    const two = figs[1];
    expect(spread(two.full, BLUR)).toBeLessThanOrEqual(3);
    if (two.crop) expect(spread(two.crop, BLUR, two.cropBox!)).toBeLessThanOrEqual(3);
    expect(spread(join(result.screenshotsDir, "step-02.png"), BLUR, undefined, 1)).toBeLessThanOrEqual(3);

    // The card and cover draw only from these print figures (or the site screenshots).
    const pdfInput = pdfInputFromPage(wf, result);
    const checked = new Set([one.full, one.crop, two.full, two.crop].filter(Boolean));
    for (const st of pdfInput.cardSteps) if (st.figure) expect(checked.has(st.figure.crop ?? st.figure.full)).toBe(true);
  }, 60_000);
});

