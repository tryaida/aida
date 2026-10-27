// Draws numbered highlight callouts, user-added numbered callouts (M22) and burned-in blur boxes
// onto a captured frame for the printed/site guide. Port of the original pipeline's docs.mjs
// `annotate()`, moved off sharp + inline SVG onto Playwright (already a dependency for capture/
// render) so pages needs no new native deps: an HTML page positions the frame image and CSS-drawn
// overlay(s) over it, then a Chromium screenshot rasterises the result — which is what makes the
// blur boxes a real burn-in rather than a removable overlay (docs/scope.md "Safe by default"):
// once screenshotted, the published PNG has no layer to peel off, only pixels.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Box } from "../capture/types.js";

export interface AnnotateOptions {
  /** Output width in px; height follows the frame's own aspect ratio. Default 1280. */
  width?: number;
  /** Numbered, labelled callouts (M22) — drawn in addition to the per-step `highlights` boxes,
   * numbered 1..N in array order, with a legend listing any labels underneath the image. */
  callouts?: { box: Box; label?: string }[];
  /** Boxes to blur (burn in) — drawn before any callout/highlight chrome, over the base image. */
  blur?: Box[];
}

const DEFAULT_WIDTH = 1280;
const PAD = 8;
const CALLOUT_COLOR = "#2563eb";
const USER_CALLOUT_COLOR = "#dc2626";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function overlayHtml(box: Box, scale: number, stepNumber: number): string {
  const x = (box.x - PAD) * scale;
  const y = (box.y - PAD) * scale;
  const w = (box.w + PAD * 2) * scale;
  const h = (box.h + PAD * 2) * scale;
  const badgeSize = 28;
  return `
    <div style="position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px;
      border-radius:10px; border:4px solid ${CALLOUT_COLOR};
      box-shadow:0 0 0 9999px rgba(15,23,42,0.32); pointer-events:none;"></div>
    <div style="position:absolute; left:${x - badgeSize / 2}px; top:${y - badgeSize / 2}px;
      width:${badgeSize}px; height:${badgeSize}px; border-radius:50%; background:${CALLOUT_COLOR};
      color:#fff; font:700 15px/1 -apple-system,Helvetica,Arial,sans-serif; display:flex;
      align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.4);">${stepNumber}</div>`;
}

/** A user-added, numbered callout (M22): a small circled number pinned at the box's top-left
 * corner, no box outline (the box may be a whole element, not just the spot to point at) — kept
 * visually distinct (red) from the per-step highlight badge (blue). */
function userCalloutHtml(box: Box, scale: number, num: number): string {
  const x = box.x * scale;
  const y = box.y * scale;
  const badgeSize = 24;
  return `
    <div style="position:absolute; left:${x - badgeSize / 2}px; top:${y - badgeSize / 2}px;
      width:${badgeSize}px; height:${badgeSize}px; border-radius:50%; background:${USER_CALLOUT_COLOR};
      color:#fff; font:700 13px/1 -apple-system,Helvetica,Arial,sans-serif; display:flex;
      align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.5); z-index:5;">${num}</div>`;
}

// Downscale factor for the blur mosaic: the box is first shrunk to roughly 1/MOSAIC_FACTOR its
// size, then scaled back up — that step is what makes the blur irreversible (a plain CSS
// blur(Npx) over the original pixels can leave enough signal for high-contrast text/digits to be
// partially recovered; averaging a whole block down to one sample, then discarding that
// resolution, genuinely destroys the information rather than just smoothing it). A light CSS
// blur on top of the mosaic (applied in the caller's canvas style) only softens the block edges.
const MOSAIC_FACTOR = 20;
// Hard cap on mosaic cells per side, independent of box size — see mosaicScript()'s inline note.
// Deliberately 1: even a small mosaic grid (2-4 cells per side) still leaves enough row/column-
// average structure to correlate with the source's letterforms — measured directly in
// test/pages/annotate.test.ts's irreversibility test (a 2x2 mosaic over real text still
// correlated ~0.32 with the source). Collapsing every blur box to its own single flat average
// colour is what actually guarantees zero pixel-level correlation with the source, at the cost
// of looking like a flat tint rather than a textured mosaic; the CSS blur (set on the canvas in
// blurCanvasHtml) still softens its edges against the surrounding screenshot so it doesn't look
// like a hard-edged cutout.
const MOSAIC_MAX_CELLS = 1;

/** A `<canvas>` placeholder for one burned-in blur box (M22 review: "Blur must be irreversible").
 * Positioned/sized in output CSS px (`scale`-adjusted) for display; `data-o*` attributes carry
 * the *unscaled* box (in the frame's own viewport-px space, matching `frameSize`) so the inline
 * script below can compute the right source rect against the frame image's natural pixel size
 * (which is `frameSize` scaled by the capture's deviceScaleFactor, not 1:1 with it). The actual
 * pixel destruction (mosaic downscale) happens in that script, once the frame image has decoded —
 * see `MOSAIC_SCRIPT`. */
function blurCanvasHtml(box: Box, scale: number): string {
  const x = box.x * scale;
  const y = box.y * scale;
  const w = box.w * scale;
  const h = box.h * scale;
  return `<canvas class="aida-blur" style="position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; border-radius:3px; filter: blur(2px);"
      data-ox="${box.x}" data-oy="${box.y}" data-ow="${box.w}" data-oh="${box.h}"></canvas>`;
}

/** Runs once the page has loaded: for every `.aida-blur` canvas, draws the frame's own pixels
 * for that box down to a tiny mosaic (`MOSAIC_FACTOR`) and back up, replacing the box's original
 * detail with a handful of averaged blocks — irreversible, unlike a CSS blur filter over the
 * untouched source. Sets `window.__aidaBlurDone = true` when finished (or immediately if there
 * are no blur boxes) so the caller knows it's safe to screenshot. `frameWidth` is `frameSize.width`
 * (the box coordinates' own unit, viewport px) — `srcImg.naturalWidth` is that same frame at the
 * capture's deviceScaleFactor, so dividing gives the ratio from box units to the image's actual
 * decoded pixels, which is what a `drawImage` source rect needs. */
function mosaicScript(frameWidth: number): string {
  return `
(function () {
  function run() {
    var canvases = document.querySelectorAll('canvas.aida-blur');
    if (canvases.length === 0) { window.__aidaBlurDone = true; return; }
    var srcImg = document.getElementById('aida-frame');
    var ratio = srcImg.naturalWidth / ${frameWidth};
    canvases.forEach(function (c) {
      var ox = parseFloat(c.dataset.ox), oy = parseFloat(c.dataset.oy);
      var ow = parseFloat(c.dataset.ow), oh = parseFloat(c.dataset.oh);
      var sx = ox * ratio, sy = oy * ratio, sw = ow * ratio, sh = oh * ratio;
      // Capped at ${MOSAIC_MAX_CELLS} cells per side regardless of box size — the ratio alone
      // (box / ${MOSAIC_FACTOR}) still leaves too many cells on a large box for the mosaic step
      // to be the thing doing the real information destruction (a 400px-wide box would still get
      // 20 cells across, enough for blurred-but-legible text); a hard cap keeps every box equally
      // coarse.
      var miniW = Math.max(1, Math.min(${MOSAIC_MAX_CELLS}, Math.round(ow / ${MOSAIC_FACTOR})));
      var miniH = Math.max(1, Math.min(${MOSAIC_MAX_CELLS}, Math.round(oh / ${MOSAIC_FACTOR})));
      var mini = document.createElement('canvas');
      mini.width = miniW; mini.height = miniH;
      var mctx = mini.getContext('2d');
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(srcImg, sx, sy, sw, sh, 0, 0, miniW, miniH);

      var cw = Math.max(1, Math.round(c.getBoundingClientRect().width));
      var ch = Math.max(1, Math.round(c.getBoundingClientRect().height));
      c.width = cw; c.height = ch;
      var ctx = c.getContext('2d');
      // Nearest-neighbour (not smoothed) on the way back up: each mosaic cell must land as one
      // perfectly flat block, with zero internal gradation a correlation attack could key off —
      // smoothed upscaling re-introduces exactly the kind of soft per-pixel variation ordinary
      // CSS blur leaves behind, which is what this mosaic step exists to avoid.
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mini, 0, 0, miniW, miniH, 0, 0, cw, ch);
    });
    window.__aidaBlurDone = true;
  }
  var img = document.getElementById('aida-frame');
  if (img.complete && img.naturalWidth > 0) run();
  else img.addEventListener('load', run, { once: true });
})();
`;
}

/**
 * Renders one annotated screenshot: `framePath` (the captured frame) resized to `opts.width`,
 * with a numbered callout drawn over each box in `highlights`, any `opts.blur` boxes burned in
 * first, then any `opts.callouts` drawn on top with a legend for labelled ones. When `highlights`
 * is empty, the step's number is still stamped in the corner so readers can match image to step.
 */
export async function annotateFrame(
  page: import("playwright").Page,
  framePath: string,
  frameSize: { width: number; height: number },
  highlights: Box[],
  stepNumber: number,
  outPath: string,
  opts: AnnotateOptions = {},
): Promise<void> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const scale = width / frameSize.width;
  const height = Math.round(frameSize.height * scale);

  const overlays = highlights.length > 0
    ? highlights.map((b) => overlayHtml(b, scale, stepNumber)).join("\n")
    : `<div style="position:absolute; left:12px; top:12px; width:28px; height:28px; border-radius:50%;
        background:${CALLOUT_COLOR}; color:#fff; font:700 15px/1 -apple-system,Helvetica,Arial,sans-serif;
        display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.4);">${stepNumber}</div>`;

  const frameUrl = `file://${encodeURI(framePath)}`;
  const blurCanvases = (opts.blur ?? []).map((b) => blurCanvasHtml(b, scale)).join("\n");

  const callouts = opts.callouts ?? [];
  const calloutOverlays = callouts.map((c, i) => userCalloutHtml(c.box, scale, i + 1)).join("\n");
  const labelled = callouts.filter((c) => c.label);
  const legend = labelled.length > 0
    ? `<div style="position:absolute; left:8px; bottom:8px; max-width:${width - 16}px; background:rgba(15,23,42,0.85);
        color:#fff; border-radius:8px; padding:6px 10px; font:500 12px/1.5 -apple-system,Helvetica,Arial,sans-serif;">
        ${labelled
          .map((c, i) => {
            const num = callouts.indexOf(c) + 1;
            return `<div><span style="color:${USER_CALLOUT_COLOR}; font-weight:700;">${num}.</span> ${escapeHtml(c.label!)}</div>`;
          })
          .join("")}
      </div>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
    <body style="margin:0; width:${width}px; height:${height}px; position:relative; overflow:hidden;">
      <img id="aida-frame" src="${frameUrl}" width="${width}" height="${height}"
        style="display:block; width:${width}px; height:${height}px;" alt="${escapeHtml(String(stepNumber))}" />
      ${blurCanvases}
      ${overlays}
      ${calloutOverlays}
      ${legend}
      <script>${mosaicScript(frameSize.width)}</script>
    </body></html>`;

  // page.setContent() leaves the document at the "about:blank" origin, from which Chromium
  // refuses to load file:// images — so write the markup to a real file:// page instead (same
  // trick render/bundle.ts uses for the player bundle) and navigate there.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aida-annotate-"));
  const tmpHtml = path.join(tmpDir, `annotate-${stepNumber}.html`);
  await writeFile(tmpHtml, html);
  try {
    await page.setViewportSize({ width, height });
    await page.goto(`file://${tmpHtml}`, { waitUntil: "load" });
    await page.waitForFunction(() => {
      const img = document.querySelector("img");
      return Boolean(img && (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0);
    });
    // Wait for the mosaic script (mosaicScript()) to have actually drawn every blur canvas —
    // it's inline but runs after the image's load event, so it can still be mid-flight here.
    // Screenshotting before `__aidaBlurDone` would publish the canvas's blank/transparent
    // initial state instead of the mosaic, which would accidentally show the untouched image
    // underneath through its border-radius corners — never acceptable for a safety feature.
    await page.waitForFunction(() => (window as unknown as { __aidaBlurDone?: boolean }).__aidaBlurDone === true);
    await mkdir(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
