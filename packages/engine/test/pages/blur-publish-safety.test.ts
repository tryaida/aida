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
});
