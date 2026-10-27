// Unit coverage for M22: annotateFrame's blur burn-in (pixels in the box actually changed, and
// the blur meaningfully reduces local contrast — proving it's a real pixel effect, not a
// translucent overlay that would leave the underlying detail readable) and numbered-callout
// drawing.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { annotateFrame } from "../../src/pages/annotate.js";

const dirs: string[] = [];
async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const VIEWPORT = { width: 200, height: 150 };

/** Renders a high-contrast checkerboard PNG (so a real blur visibly changes it, unlike a flat
 * fixture) via Playwright — same renderer annotateFrame itself uses, so no new dependency. */
async function makeCheckerboardFrame(page: import("playwright").Page, outPath: string): Promise<void> {
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
}

function readPng(path: string): InstanceType<typeof PNG> {
  return PNG.sync.read(readFileSync(path));
}

/** Variance of the red channel inside a box — a checkerboard has high variance; a blurred/
 * averaged region has much lower variance. */
function redVariance(png: InstanceType<typeof PNG>, box: { x: number; y: number; w: number; h: number }): number {
  const values = redValues(png, box);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

function redValues(png: InstanceType<typeof PNG>, box: { x: number; y: number; w: number; h: number }): number[] {
  const values: number[] = [];
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const idx = (png.width * y + x) * 4;
      values.push(png.data[idx]);
    }
  }
  return values;
}

/** Pearson correlation between two equal-length pixel-value arrays — this is the irreversibility
 * check: a plain CSS `blur(Npx)` over untouched source pixels stays strongly *positively*
 * correlated with the source (same light/dark pattern, just softened — recoverable in principle
 * with a deconvolution), whereas the mosaic's averaged blocks bear no pixel-for-pixel
 * relationship to the source's fine detail at all once downscaled past it, so values near 0. */
function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** Renders black high-contrast digits/text on white — closer to the real worry (an email, a
 * phone number) than a checkerboard, and sharper-edged, so any recoverable structure left behind
 * by an insufficient blur would show up clearly in the correlation check. */
async function makeTextFrame(page: import("playwright").Page, outPath: string): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.setContent(
    `<!doctype html><html><body style="margin:0; width:${VIEWPORT.width}px; height:${VIEWPORT.height}px; position:relative; background:#fff;">
      <div style="position:absolute; left:40px; top:50px; font:700 28px monospace; color:#000; letter-spacing:2px;">0491 570 156</div>
    </body></html>`,
  );
  await page.screenshot({ path: outPath });
}

describe("annotateFrame", () => {
  it("is irreversible: a mosaic'd phone number doesn't correlate with the source text", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const dir = await tmpDir("aida-annotate-text-");
      const framePath = join(dir, "frame.png");
      const outPath = join(dir, "out.png");
      const page = await browser.newPage();
      await makeTextFrame(page, framePath);

      const blurBox = { x: 35, y: 45, w: 130, h: 40 };
      await annotateFrame(page, framePath, VIEWPORT, [], 1, outPath, { width: VIEWPORT.width, blur: [blurBox] });

      const before = readPng(framePath);
      const after = readPng(outPath);

      // Low variance inside the box: the sharp black-on-white strokes are gone.
      const varianceBefore = redVariance(before, blurBox);
      const varianceAfter = redVariance(after, blurBox);
      expect(varianceBefore).toBeGreaterThan(3000);
      expect(varianceAfter).toBeLessThan(varianceBefore * 0.1);

      // The key irreversibility check: per-pixel correlation between the source text and the
      // published box, over the box's *interior* (inset past the few-px band any blur softens
      // against the box's own edge, which isn't a text-recovery signal — it's just the box
      // blending into its surrounding screenshot), is near zero. A plain CSS blur over untouched
      // pixels would stay strongly correlated throughout (same shapes, just softened); the
      // mosaic genuinely discards the interior detail instead of merely smoothing it.
      const inset = { x: blurBox.x + 10, y: blurBox.y + 10, w: blurBox.w - 20, h: blurBox.h - 20 };
      const r = correlation(redValues(before, inset), redValues(after, inset));
      expect(Math.abs(r)).toBeLessThan(0.15);
    } finally {
      await browser.close();
    }
  }, 30_000);


  it("burns a blur into the box: pixels change and local contrast collapses", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const dir = await tmpDir("aida-annotate-blur-");
      const framePath = join(dir, "frame.png");
      const outPath = join(dir, "out.png");
      const page = await browser.newPage();
      await makeCheckerboardFrame(page, framePath);

      const blurBox = { x: 40, y: 40, w: 60, h: 40 };
      await annotateFrame(page, framePath, VIEWPORT, [], 1, outPath, {
        width: VIEWPORT.width, // 1:1 scale keeps box math simple to assert against
        blur: [blurBox],
      });

      const before = readPng(framePath);
      const after = readPng(outPath);

      // The checkerboard's sharp black/white alternation inside the box must have collapsed —
      // a real blur drags neighbouring extreme values toward their average.
      const varianceBefore = redVariance(before, blurBox);
      const varianceAfter = redVariance(after, blurBox);
      expect(varianceBefore).toBeGreaterThan(5000); // ~127.5^2 for a pure 0/255 checkerboard
      expect(varianceAfter).toBeLessThan(varianceBefore * 0.5);

      // At least some pixels inside the box actually changed value (the burn-in, not a no-op).
      let changed = 0;
      for (let y = blurBox.y; y < blurBox.y + blurBox.h; y++) {
        for (let x = blurBox.x; x < blurBox.x + blurBox.w; x++) {
          const idx = (before.width * y + x) * 4;
          if (Math.abs(before.data[idx] - after.data[idx]) > 10) changed++;
        }
      }
      expect(changed).toBeGreaterThan(0);

      // Outside the box, the checkerboard is untouched.
      const varianceOutsideAfter = redVariance(after, { x: 0, y: 0, w: 20, h: 20 });
      expect(varianceOutsideAfter).toBeGreaterThan(5000);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("draws numbered user callouts and a legend for labelled ones", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const dir = await tmpDir("aida-annotate-callouts-");
      const framePath = join(dir, "frame.png");
      const outPath = join(dir, "out.png");
      const page = await browser.newPage();
      await makeCheckerboardFrame(page, framePath);

      // A plain white patch to drop a callout badge (red) on, so we can assert red pixels show
      // up exactly where the badge should be.
      const calloutBox = { x: 100, y: 10, w: 10, h: 10 };
      await annotateFrame(page, framePath, VIEWPORT, [], 1, outPath, {
        width: VIEWPORT.width,
        callouts: [{ box: calloutBox, label: "Click here" }],
      });

      const after = readPng(outPath);
      // The badge is centred on the box's top-left corner (userCalloutHtml) — scan a small
      // neighbourhood around it for a strongly red, non-grey pixel (the badge's fill colour).
      let foundRed = false;
      for (let y = calloutBox.y - 12; y < calloutBox.y + 12; y++) {
        for (let x = calloutBox.x - 12; x < calloutBox.x + 12; x++) {
          if (x < 0 || y < 0 || x >= after.width || y >= after.height) continue;
          const idx = (after.width * y + x) * 4;
          const [r, g, b] = [after.data[idx], after.data[idx + 1], after.data[idx + 2]];
          if (r > 150 && g < 100 && b < 100) foundRed = true;
        }
      }
      expect(foundRed).toBe(true);

      // A legend band (dark, near-opaque) must exist near the bottom-left for the labelled callout.
      let foundLegend = false;
      for (let y = after.height - 30; y < after.height - 2; y++) {
        for (let x = 4; x < 100; x++) {
          const idx = (after.width * y + x) * 4;
          const [r, g, b, a] = [after.data[idx], after.data[idx + 1], after.data[idx + 2], after.data[idx + 3]];
          if (a > 200 && r < 40 && g < 60 && b < 80) foundLegend = true;
        }
      }
      expect(foundLegend).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
