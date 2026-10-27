// M32 visual check (decision 36): renders the fictional "Acme Orders" fixture guide
// (test/fixtures/print/add-an-order.yaml) through the real pages + PDF pipeline — screens drawn
// here with Playwright, focus crops, the card — then rasterises the PDFs and checks the basics:
// page count, real embedded fonts (no Type 3), pages that aren't mostly blank, a card that fills
// its page. Slow (Chromium print + pdftoppm), so gated behind AIDA_TEST_SLOW like the other
// render tests; the pdffonts/pdftoppm checks skip when poppler isn't installed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { loadWalkthroughFile } from "../../src/walkthrough/index.js";
import { buildPage } from "../../src/pages/build.js";
import { pdfInputFromPage } from "../../src/pdf/input.js";
import { buildWalkthroughPdf, launchBrowser, pageCount } from "../../src/pdf/build.js";
import { buildCardHtml } from "../../src/pdf/html.js";
import { cardOverflows } from "../../src/pdf/render.js";

const SLOW = process.env.AIDA_TEST_SLOW === "1";
const FIXTURE = fileURLToPath(new URL("../fixtures/print/add-an-order.yaml", import.meta.url));
const VIEWPORT = { width: 1440, height: 810 };
const has = (cmd: string): boolean => spawnSync(cmd, ["-v"], { stdio: "ignore" }).error === undefined;

const dirs: string[] = [];
afterAll(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const NEW_ORDER = { x: 1220, y: 96, w: 150, h: 40 };
const CUSTOMER = { x: 330, y: 230, w: 420, h: 40 };
const SAVE = { x: 1200, y: 700, w: 150, h: 40 };

/** A plain fake app screen: sidebar, header, and either the orders list or the order form. */
function screenHtml(kind: "list" | "form", opts: { hover?: boolean; quantity?: string } = {}): string {
  const field = (label: string, y: number, value = "") =>
    `<div style="position:absolute;left:330px;top:${y - 26}px;font:600 14px sans-serif;color:#334155">${label}</div>
     <div style="position:absolute;left:330px;top:${y}px;width:420px;height:40px;border:1px solid #cbd5e1;border-radius:6px;font:14px/40px sans-serif;padding-left:12px;box-sizing:border-box;color:#0f172a">${value}</div>`;
  const button = (b: typeof NEW_ORDER, text: string) =>
    `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border-radius:6px;background:${opts.hover ? "#1e40af" : "#2563eb"};color:#fff;font:600 14px/40px sans-serif;text-align:center">${text}</div>`;
  const rows = Array.from({ length: 8 }, (_, i) => `<div style="position:absolute;left:300px;top:${200 + i * 52}px;width:1080px;height:44px;border-bottom:1px solid #e2e8f0;font:14px/44px sans-serif;color:#334155">Order A-10${i} &nbsp; Customer ${i + 1} &nbsp; Draft</div>`).join("");
  const body = kind === "list"
    ? `<div style="position:absolute;left:300px;top:100px;font:700 26px sans-serif">Orders</div>${button(NEW_ORDER, "New order")}${rows}`
    : `<div style="position:absolute;left:300px;top:100px;font:700 26px sans-serif">New order</div>${field("Customer", CUSTOMER.y, "Sam Example")}${field("Quantity", 330, opts.quantity ?? "")}${field("Notes", 430)}${button(SAVE, "Save draft")}`;
  return `<!doctype html><html><body style="margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;position:relative;background:#f8fafc;overflow:hidden">
    <div style="position:absolute;left:0;top:0;width:240px;height:100%;background:#0f172a;color:#cbd5e1;font:14px sans-serif">
      <div style="padding:20px;font:700 18px sans-serif;color:#fff">Acme Orders</div>
      <div style="padding:10px 20px;background:#1e293b">Orders</div><div style="padding:10px 20px">Customers</div><div style="padding:10px 20px">Reports</div></div>
    <div style="position:absolute;left:240px;top:0;right:0;height:64px;background:#fff;border-bottom:1px solid #e2e8f0"></div>
    ${body}</body></html>`;
}

async function drawFrames(framesDir: string): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const shots: Record<string, string> = {
      "01-list.png": screenHtml("list"),
      "02-hover.png": screenHtml("list", { hover: true }),
      "03-form.png": screenHtml("form"),
      "04-typed.png": screenHtml("form", { quantity: "12" }),
      "05-hover.png": screenHtml("form", { quantity: "12", hover: true }),
      "06-list.png": screenHtml("list"),
    };
    for (const [file, html] of Object.entries(shots)) {
      await page.setContent(html);
      await page.screenshot({ path: join(framesDir, file) });
    }
  } finally {
    await browser.close();
  }
}

function mstep(id: string, events: ManifestStep["events"], doc: ManifestStep["doc"], urls: string[] = []): ManifestStep {
  return { id, camera: "full", cameraBox: null, events, doc, impact: { urls, requests: [] }, checks: [] };
}

function manifest(): CaptureManifest {
  const frame = (image: string) => ({ type: "frame" as const, image, transition: "cut" as const });
  return {
    workflow: "add-an-order",
    baseUrl: "http://127.0.0.1:3100",
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    steps: [
      mstep("open-orders", [frame("01-list.png")], { image: "01-list.png", highlights: [] }),
      mstep("new-order", [frame("02-hover.png"), { type: "highlight", box: NEW_ORDER }, { type: "click", at: { x: 1295, y: 116 } }, frame("03-form.png")], { image: "03-form.png", highlights: [NEW_ORDER] }, ["/orders/new"]),
      mstep("choose-customer", [frame("03-form.png"), { type: "highlight", box: CUSTOMER }], { image: "03-form.png", highlights: [CUSTOMER] }),
      mstep("enter-quantity", [frame("03-form.png"), { type: "click", at: { x: 420, y: 350 } }, frame("04-typed.png")], { image: "04-typed.png", highlights: [] }),
      mstep("save-draft", [frame("05-hover.png"), { type: "highlight", box: SAVE }, { type: "click", at: { x: 1275, y: 720 } }, frame("06-list.png")], { image: "06-list.png", highlights: [SAVE] }, ["/orders"]),
    ],
  };
}

/** How far down the page (0..1) content reaches above `below` (the running footer's band), and
 * the overall share of non-white pixels. */
function inkProfile(pngFile: string, below = 1): { lastInkRow: number; ink: number } {
  const png = PNG.sync.read(readFileSync(pngFile));
  let last = 0;
  let inked = 0;
  for (let y = 0; y < png.height; y++) {
    let rowInk = false;
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] < 235 || png.data[i + 1] < 235 || png.data[i + 2] < 235) {
        rowInk = true;
        inked++;
      }
    }
    if (rowInk && y / png.height < below) last = y;
  }
  return { lastInkRow: last / png.height, ink: inked / (png.width * png.height) };
}

describe.skipIf(!SLOW)("M32: the fixture guide renders as a designed manual", () => {
  it("renders the guide and card with real fonts, filled pages and focus crops", async () => {
    const root = mkdtempSync(join(tmpdir(), "aida-print-"));
    dirs.push(root);
    const captureDir = join(root, "capture");
    mkdirSync(join(captureDir, "frames"), { recursive: true });
    await drawFrames(join(captureDir, "frames"));
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest()));
    const validation: ValidationResult = {
      workflow: "add-an-order",
      ranAt: "2026-10-20T00:00:00.000Z",
      baseUrl: "http://127.0.0.1:3100",
      ok: true,
      steps: manifest().steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok: true, ms: 1 })),
      dbChecks: [],
      problems: { console: [], page: [], server: [] },
    };
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));

    const wf = loadWalkthroughFile(FIXTURE);
    const page = await buildPage(wf, captureDir, join(root, "pages"));
    expect(page.publishable).toBe(true);
    const figs = page.printFigures!;
    expect(figs).toHaveLength(5);
    // Step 2's click opened the form: its figure is the list (where the button is), cropped.
    expect(figs[1]).toMatchObject({ newScreen: false, targets: [NEW_ORDER] });
    expect(figs[1].crop && existsSync(figs[1].crop)).toBeTruthy();
    expect(figs.map((f) => f.newScreen)).toEqual([true, false, true, false, false]);

    // A brand font served from the font cache (fonts.ts) — a local system TTF stands in for the
    // downloaded file, so no network is needed.
    const fontCacheDir = join(root, "fonts");
    // Regular and bold, as a real brand font has: a weight the font lacks is synthesised by
    // Chromium, and synthetic bold prints as Type 3.
    const systemFont = [
      ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
      ["/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
    ].find((pair) => pair.every(existsSync));
    const fontUrl = "https://fonts.example.com/css2?family=Acme+Sans";
    if (systemFont) {
      mkdirSync(fontCacheDir, { recursive: true });
      const faces = systemFont.map((src, i) => {
        const file = join(fontCacheDir, `acme-sans-${i}.ttf`);
        copyFileSync(src, file);
        return { family: "Acme Sans", style: "normal", weight: i === 0 ? "400" : "700", file, format: "truetype" };
      });
      const key = createHash("sha256").update(fontUrl).digest("hex").slice(0, 24);
      writeFileSync(join(fontCacheDir, `${key}.json`), JSON.stringify(faces));
    }

    const pdfDir = join(root, "pdf");
    const browser = await launchBrowser();
    try {
      const built = await buildWalkthroughPdf(
        pdfInputFromPage(wf, page),
        {
          pdfDir,
          brand: { name: "Acme Orders", colors: { primary: "#0f766e" }, ...(systemFont ? { font: "Acme Sans", fontUrl } : {}) },
          siteUrl: "https://help.example.com",
          fontCacheDir,
        },
        browser,
      );
      expect(built.excluded).toBe(false);
      const pages = await pageCount(readFileSync(built.file));
      expect(pages).toBeGreaterThanOrEqual(1);
      expect(pages).toBeLessThanOrEqual(3);
      expect(await pageCount(readFileSync(built.cardFile))).toBe(1);

      if (has("pdffonts")) {
        for (const f of [built.file, built.cardFile]) {
          const out = spawnSync("pdffonts", [f], { encoding: "utf8" }).stdout;
          expect(out).not.toMatch(/Type 3/);
          if (systemFont) expect(out).toMatch(/DejaVuSans-Bold/);
        }
      }

      if (has("pdftoppm")) {
        const rasterDir = join(root, "raster");
        mkdirSync(rasterDir);
        spawnSync("pdftoppm", ["-r", "30", "-png", built.file, join(rasterDir, "guide")]);
        spawnSync("pdftoppm", ["-r", "30", "-png", built.cardFile, join(rasterDir, "card")]);
        const guidePngs = readdirSync(rasterDir).filter((f) => f.startsWith("guide")).sort();
        expect(guidePngs).toHaveLength(pages);
        guidePngs.forEach((f, i) => {
          const p = inkProfile(join(rasterDir, f), 1 - 19 / 297);
          expect(p.ink).toBeGreaterThan(i === 0 ? 0.03 : 0.005);
          // No page more than half empty unless it ends the guide (decision 36). The footer sits at
          // the very bottom of every page, so the check is on how far down the content reaches.
          if (i < guidePngs.length - 1) expect(p.lastInkRow).toBeGreaterThan(0.5);
        });
        const card = inkProfile(join(rasterDir, readdirSync(rasterDir).find((f) => f.startsWith("card"))!));
        expect(card.ink).toBeGreaterThan(0.08);
        expect(card.lastInkRow).toBeGreaterThan(0.85);
      }
    } finally {
      await browser.close();
    }
  }, 180_000);

  // M32 review: the card grid hides overflow, so the page count can't catch clipped text — the
  // fit loop measures it instead and falls back to smaller text or the text-only list.
  it("measures clipped card text that the page count can't see", async () => {
    // Layout only: the image needn't load (a broken image still takes the frame's box).
    const fig = (n: number) => ({
      step: n,
      full: "/nonexistent/aida-card-step.png",
      viewport: VIEWPORT,
      targets: [],
      callouts: [],
      newScreen: false,
    });
    const steps = (text: string) => [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `Step ${n}`, text, figure: fig(n) }));
    const browser = await launchBrowser();
    try {
      expect(await cardOverflows(browser, buildCardHtml("Add an order", steps("Click Save."), undefined, { paper: "A4" }), "A4")).toBe(false);
      const long = "Check every line on the order against the customer's request before you go on, including quantities, prices and delivery notes. ".repeat(3);
      expect(await cardOverflows(browser, buildCardHtml("Add an order", steps(long), undefined, { paper: "A4" }), "A4")).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

