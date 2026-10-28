// `aida proof` (decision 35, checkpoint 1): one sheet showing how the brand lands on every output,
// side by side, to approve once — a help site page (a screenshot when the site is running, else
// the page's own layout), a printed page and the quick reference card (rendered from fresh PDFs
// when poppler's `pdftoppm` is installed, else from their print HTML), and the video's intro card
// and a step frame. Written to `<buildDir>/proof/` (proof.png, proof.html, proof.json and the
// panel images); the Studio shows it. Reads the build's capture and page; changes no outputs.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Browser } from "playwright";
import type { CaptureManifest } from "../capture/types.js";
import type { ResolvedConfig } from "../config/types.js";
import type { BuildPageResult } from "../pages/types.js";
import { buildCardHtml, buildPageHtml, pdfTheme } from "../pdf/html.js";
import { buildWalkthroughPdf, prepareBrand } from "../pdf/build.js";
import { pdfInputFromPage } from "../pdf/input.js";
import { launchBrowser } from "../pdf/render.js";
import { escapeHtml } from "../pdf/markdown.js";
import type { PdfPageInput } from "../pdf/types.js";
import { resolveArtifactBrand, imageDataUrl, type ArtifactBrand } from "../render/brand.js";
import { writePlayerBundle } from "../render/bundle.js";
import { beatIds, buildTimeline } from "../render/timeline.js";
import type { NarrationBeat, Timeline } from "../render/types.js";
import { loadNarrationBeats } from "../render/voice-input.js";
import { qualityFor } from "../render/video.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import { renderBrandCss } from "../theme/write.js";
import { cardText } from "../walkthrough/cards.js";
import { SITE_PAGE_WIDTH, sitePageHtml } from "./site-page.js";

const execFileAsync = promisify(execFile);

export interface ProofOptions {
  /** Walkthrough id to show (default: the first one with a capture and a built page). */
  walkthrough?: string;
  /** Help site to screenshot (default `publish.siteUrl`); skipped when it doesn't answer. */
  siteUrl?: string;
  /** Output dir (default `<buildDir>/proof`). */
  outDir?: string;
}

export interface ProofPanel {
  id: "site" | "page" | "card" | "intro" | "step";
  label: string;
  /** File name inside the proof dir. */
  file: string;
  /** How it was made, when it isn't the real thing (e.g. "print layout: the site isn't running"). */
  note?: string;
}

export interface ProofResult {
  dir: string;
  png: string;
  html: string;
  json: string;
  walkthrough: string;
  style: string;
  panels: ProofPanel[];
  generatedAt: string;
}

interface Picked {
  wf: Walkthrough;
  manifest: CaptureManifest;
  captureDir: string;
  page?: BuildPageResult;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The walkthrough to show: the one asked for, else the first (by file name) with a capture,
 * preferring one with a built page too. */
export function pickWalkthrough(config: Pick<ResolvedConfig, "walkthroughsDir" | "buildDir">, id?: string): Picked {
  const files = existsSync(config.walkthroughsDir)
    ? readdirSync(config.walkthroughsDir).filter((f) => /\.ya?ml$/i.test(f)).sort()
    : [];
  const candidates: Picked[] = [];
  for (const f of files) {
    let wf: Walkthrough;
    try {
      wf = loadWalkthroughFile(path.join(config.walkthroughsDir, f));
    } catch {
      continue;
    }
    if (id && wf.walkthrough !== id) continue;
    const captureDir = path.join(config.buildDir, wf.walkthrough, "capture");
    const manifest = readJson<CaptureManifest>(path.join(captureDir, "manifest.json"));
    if (!manifest) continue;
    const page = readJson<{ result: BuildPageResult }>(path.join(config.buildDir, wf.walkthrough, "pages-cache.json"))?.result;
    candidates.push({ wf, manifest, captureDir, page });
  }
  const best = candidates.find((c) => c.page) ?? candidates[0];
  if (!best) {
    throw new Error(
      id
        ? `no capture for "${id}" in ${config.buildDir} — run \`aida capture ${id}\` (or \`aida build\`) first`
        : `no captured walkthrough in ${config.buildDir} — run \`aida build\` (or \`aida capture <walkthrough>\`) first`,
    );
  }
  return best;
}

/** Narration lengths for the timeline: the build's own voice output when there is one, else an
 * even estimate from each line's length (stills only — nothing is played). */
function narrationFor(wf: Walkthrough, voiceDir: string): Record<string, NarrationBeat> {
  if (existsSync(path.join(voiceDir, "manifest.json"))) {
    try {
      const beats = loadNarrationBeats(voiceDir);
      if (beatIds(wf).every((b) => beats[b])) return beats;
    } catch {
      // fall through to estimates
    }
  }
  const line = (id: string): string => {
    if (id === "intro") return cardText(wf).intro.say;
    if (id === "outro") return cardText(wf).outro.say;
    return wf.steps.find((s) => s.id === id)?.say ?? "";
  };
  return Object.fromEntries(beatIds(wf).map((id) => [id, { audioPath: "", durationMs: Math.max(1200, line(id).length * 65) }]));
}

/** Intro: once every card element is in. Step: the first highlighted target, ring up and the
 * camera pushed in; else the middle of the first step. */
export function proofInstants(tl: Timeline): { intro: number; step: number } {
  const lastReveal = Math.max(...(tl.cards?.intro ?? []).map((r) => r.t0 + r.d), 2.4);
  const intro = Math.min(lastReveal + 0.2, tl.stageIn.t0 - 0.05);
  const hi = tl.highlights[0];
  const firstStep = tl.scenes?.find((s) => s.id !== "intro");
  const step = hi
    ? Math.min(hi.t1 - 0.05, hi.t0 + 1.0)
    : firstStep
      ? (firstStep.t0 + firstStep.t1) / 2
      : tl.stageIn.t1 + 1;
  return { intro: Number(intro.toFixed(3)), step: Number(step.toFixed(3)) };
}

async function hasPdftoppm(): Promise<boolean> {
  try {
    await execFileAsync("pdftoppm", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

/** First page of a PDF as PNG (poppler), or false when that isn't possible. */
async function rasterizePdf(pdf: string, outPng: string): Promise<boolean> {
  if (!existsSync(pdf)) return false;
  const base = outPng.replace(/\.png$/, "");
  try {
    await execFileAsync("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "1", "-singlefile", pdf, base]);
    return existsSync(outPng);
  } catch {
    return false;
  }
}

/** Screenshots an HTML document (written beside the output, so its file:// images load). */
async function shootHtml(browser: Browser, html: string, file: string, width: number, height: number, print: boolean): Promise<void> {
  const htmlFile = file.replace(/\.png$/, ".src.html");
  writeFileSync(htmlFile, html);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    if (print) await page.emulateMedia({ media: "print" });
    await page.goto(`file://${htmlFile}`, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready").catch(() => {});
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } });
  } finally {
    await page.close();
    rmSync(htmlFile, { force: true });
  }
}

/** Screenshots a whole HTML document at `width`, as tall as its content (no clipping). */
async function shootFullPage(browser: Browser, html: string, file: string, width: number): Promise<void> {
  const htmlFile = file.replace(/\.png$/, ".src.html");
  writeFileSync(htmlFile, html);
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`file://${htmlFile}`, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready").catch(() => {});
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await page.close();
    rmSync(htmlFile, { force: true });
  }
}

/** The help app's light-theme brand variables as a `:root` rule: the custom property
 * declarations (`--name: value;`) of `app/brand.css`'s first rule, nothing else — no selector,
 * at-rule or `url()` from the file reaches the render. Rendered from config when the file is
 * missing or has none. */
export function siteBrandCss(config: Pick<ResolvedConfig, "helpApp" | "brand">): string {
  const file = config.helpApp ? path.join(config.helpApp, "app", "brand.css") : undefined;
  let text = "";
  try {
    if (file && existsSync(file)) text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  const vars = brandVars(text);
  return vars.length > 0 ? `:root {\n${vars.map((v) => `  ${v}`).join("\n")}\n}\n` : renderBrandCss(config.brand);
}

/** `--name: value;` declarations in the first `{…}` rule of a stylesheet, values limited to
 * colours, lengths, font names and `var()`/`color-mix()`/`hsl()` calls. */
export function brandVars(css: string): string[] {
  const body = /\{([^{}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "";
  const out: string[] = [];
  for (const m of body.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;{}]*);/g)) {
    const value = m[2].trim();
    if (!/^[A-Za-z0-9\s#%.,()"'\-+*/]*$/.test(value) || /url\s*\(|expression\s*\(|@/i.test(value)) continue;
    out.push(`${m[1]}: ${value};`);
  }
  return out;
}

/** Titles of the other guides, for the sidebar. */
function siblingTitles(config: Pick<ResolvedConfig, "walkthroughsDir">, id: string): string[] {
  if (!existsSync(config.walkthroughsDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(config.walkthroughsDir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    try {
      const wf = loadWalkthroughFile(path.join(config.walkthroughsDir, f));
      if (wf.walkthrough !== id) out.push(wf.title);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

async function siteAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000), redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

/** A4 at 96 dpi, with the PDF's side margin, for the print-HTML fallback. */
const A4 = { width: 794, height: 1123 };
const PRINT_PAD = `<style>body { padding: 16mm 16mm 14mm !important; background: #fff; }</style>`;

export async function buildProof(config: ResolvedConfig, opts: ProofOptions = {}): Promise<ProofResult> {
  const picked = pickWalkthrough(config, opts.walkthrough);
  const { wf, manifest, captureDir } = picked;
  const dir = path.resolve(opts.outDir ?? path.join(config.buildDir, "proof"));
  mkdirSync(dir, { recursive: true });
  const brand: ArtifactBrand = resolveArtifactBrand(config);
  const panels: ProofPanel[] = [];
  const siteUrl = opts.siteUrl ?? config.publish?.siteUrl;

  // Video: the real player, the real timeline (estimated narration lengths if not voiced yet).
  const narration = narrationFor(wf, path.join(config.buildDir, wf.walkthrough, "voice"));
  const tl = buildTimeline(wf, manifest, narration, {
    fps: qualityFor(true).fps,
    frameSrc: (f) => path.join(captureDir, "frames", f),
    brand,
  });
  const bundleDir = path.join(dir, ".player");
  await writePlayerBundle(bundleDir, tl);
  const at = proofInstants(tl);

  const browser = await launchBrowser();
  try {
    const { openRenderBrowser } = await import("../render/video.js");
    const player = await openRenderBrowser(bundleDir, 0.5, 1);
    try {
      const page = player.pages[0];
      for (const [id, t, label] of [
        ["intro", at.intro, "Video: intro card"],
        ["step", at.step, "Video: a step"],
      ] as const) {
        await page.evaluate((t) => (window as unknown as { renderAt: (t: number) => Promise<void> }).renderAt(t), t);
        writeFileSync(path.join(dir, `${id}.png`), await page.screenshot({ type: "png" }));
        panels.push({ id, label, file: `${id}.png` });
      }
    } finally {
      await player.close();
    }

    // Print: needs the built page (its print figures). Real PDFs when poppler can rasterize them.
    let input: PdfPageInput | undefined;
    if (picked.page) {
      input = pdfInputFromPage(wf, picked.page);
      const prepared = await prepareBrand(browser, brand);
      const poppler = await hasPdftoppm();
      let pageDone = false;
      let cardDone = false;
      if (poppler) {
        const pdfDir = path.join(dir, "pdf");
        const r = await buildWalkthroughPdf(input, { pdfDir, paper: config.pdf?.paper ?? "A4", brand, siteUrl: config.publish?.siteUrl, force: true }, browser);
        pageDone = await rasterizePdf(r.file, path.join(dir, "page.png"));
        cardDone = await rasterizePdf(r.cardFile, path.join(dir, "card.png"));
      }
      if (!pageDone) {
        const html = buildPageHtml(input, prepared, false, { siteUrl: config.publish?.siteUrl }).replace("</head>", `${PRINT_PAD}</head>`);
        await shootHtml(browser, html, path.join(dir, "page.png"), A4.width, A4.height, true);
      }
      panels.push({ id: "page", label: "Printed guide", file: "page.png", ...(pageDone ? {} : { note: "print layout (install poppler for the real PDF page)" }) });
      if (!cardDone) {
        const html = buildCardHtml(input.title, input.cardSteps, prepared, { paper: config.pdf?.paper ?? "A4", productName: wf.product }).replace("</head>", `${PRINT_PAD}</head>`);
        await shootHtml(browser, html, path.join(dir, "card.png"), A4.width, A4.height, true);
      }
      panels.push({ id: "card", label: "Quick reference card", file: "card.png", ...(cardDone ? {} : { note: "print layout" }) });
    }

    // Site: a screenshot of the guide on the running help site, else its page layout on screen.
    const guideUrl = siteUrl && input?.sitePath ? `${siteUrl.replace(/\/+$/, "")}${input.sitePath}` : undefined;
    if (guideUrl && (await siteAnswers(guideUrl))) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
      try {
        await page.goto(guideUrl, { waitUntil: "networkidle", timeout: 30_000 });
        await page.screenshot({ path: path.join(dir, "site.png") });
        panels.push({ id: "site", label: "Help site", file: "site.png" });
      } finally {
        await page.close();
      }
    } else if (input) {
      // The built page as the help app lays it out, with the site's own brand CSS (M36): the
      // whole excerpt, never a window cut off mid-step.
      const prepared = await prepareBrand(browser, brand);
      const html = sitePageHtml(input, prepared, {
        brandCss: siteBrandCss(config),
        poster: panels.some((p) => p.id === "intro") ? path.join(dir, "intro.png") : undefined,
        siblings: siblingTitles(config, wf.walkthrough),
        facts: {
          steps: wf.steps.length,
          for: wf.for,
          lastChecked: input.lastChecked,
          passed: input.passed,
          pdf: panels.some((p) => p.id === "page"),
        },
      });
      await shootFullPage(browser, html, path.join(dir, "site.png"), SITE_PAGE_WIDTH);
      panels.push({ id: "site", label: "Help site", file: "site.png", note: guideUrl ? "built page: the site didn't answer" : "built page: no site URL (pass --site-url)" });
    }

    const generatedAt = new Date().toISOString();
    const sheet = proofSheetHtml(brand, wf, panels, generatedAt);
    const htmlFile = path.join(dir, "proof.html");
    writeFileSync(htmlFile, sheet);
    const png = path.join(dir, "proof.png");
    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`file://${htmlFile}`, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready").catch(() => {});
      await page.screenshot({ path: png, fullPage: true });
    } finally {
      await page.close();
    }
    rmSync(bundleDir, { recursive: true, force: true });
    const result: ProofResult = {
      dir,
      png,
      html: htmlFile,
      json: path.join(dir, "proof.json"),
      walkthrough: wf.walkthrough,
      style: brand.style,
      panels,
      generatedAt,
    };
    writeFileSync(result.json, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await browser.close();
  }
}

/** The sheet: brand header (logo, name, style, colours, fonts), the two video frames, then the
 * site page, printed page and card. Images by relative path, so proof.html opens on its own. */
export function proofSheetHtml(brand: ArtifactBrand, wf: Walkthrough, panels: ProofPanel[], generatedAt: string): string {
  const t = pdfTheme(brand);
  const logo = imageDataUrl(brand.logoPath) ?? imageDataUrl(brand.logoDarkPath);
  const by = (id: ProofPanel["id"]) => panels.find((p) => p.id === id);
  const fig = (p: ProofPanel | undefined, cls: string) =>
    p
      ? `<figure class="${cls}"><div class="frame"><img src="${escapeHtml(p.file)}" alt="" /></div><figcaption><b>${escapeHtml(p.label)}</b>${p.note ? ` <span>· ${escapeHtml(p.note)}</span>` : ""}</figcaption></figure>`
      : "";
  const swatch = (label: string, c: string) => `<li><i style="background:${c}"></i><span>${escapeHtml(label)}</span></li>`;
  const fonts = [brand.font ?? "System font", brand.headingFont && brand.headingFont !== brand.font ? `${brand.headingFont} (headings)` : ""].filter(Boolean).join(", ");
  const fontLink = t.fontUrl ? `<link rel="stylesheet" href="${escapeHtml(t.fontUrl)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Proof sheet</title>${fontLink}<style>
  :root { --primary: ${t.colors.primary}; --fg: ${t.colors.foreground}; --muted-fg: ${t.colors.mutedForeground}; --border: ${t.colors.border};
    --font: ${t.font ? `"${t.font}", ` : ""}system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1800px; padding: 40px 48px 48px; font-family: var(--font); color: var(--fg); background: #f4f5f7; }
  header { display: flex; align-items: center; gap: 22px; padding-bottom: 26px; margin-bottom: 30px; border-bottom: 1px solid var(--border); }
  header img { height: 44px; width: auto; max-width: 220px; object-fit: contain; }
  header h1 { font-size: 26px; letter-spacing: -0.02em; }
  header p { font-size: 14px; color: var(--muted-fg); margin-top: 3px; }
  .meta { margin-left: auto; display: flex; gap: 28px; align-items: center; font-size: 13px; color: var(--muted-fg); }
  .meta b { color: var(--fg); }
  .swatches { display: flex; gap: 12px; list-style: none; }
  .swatches li { display: flex; align-items: center; gap: 6px; }
  .swatches i { width: 18px; height: 18px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .12); }
  .row { display: grid; gap: 28px; margin-bottom: 30px; align-items: start; }
  .video { grid-template-columns: 1fr 1fr; }
  .print { grid-template-columns: 1.55fr 1fr 1fr; }
  figure .frame { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 0 0 1px rgb(15 23 42 / .08), 0 12px 30px -18px rgb(15 23 42 / .35); }
  figure img { display: block; width: 100%; height: auto; }
  figcaption { margin-top: 10px; font-size: 14px; }
  figcaption span { color: var(--muted-fg); }
  footer { font-size: 12px; color: var(--muted-fg); }
  </style></head><body>
  <header>${logo ? `<img src="${logo}" alt="" />` : ""}<div><h1>${escapeHtml(brand.name ?? wf.product ?? "Brand")} · proof sheet</h1><p>${escapeHtml(wf.title)} — how the brand lands on the video, help site and print. Approve once at checkpoint 1.</p></div>
    <div class="meta"><span>Style <b>${escapeHtml(brand.style)}</b></span><span>Font <b>${escapeHtml(fonts)}</b></span>
    <ul class="swatches">${swatch("Primary", t.colors.primary)}${swatch("Accent", t.colors.accent)}${swatch("Text", t.colors.foreground)}${swatch("Surface", t.colors.background)}</ul></div></header>
  <section class="row video">${fig(by("intro"), "v")}${fig(by("step"), "v")}</section>
  <section class="row print">${fig(by("site"), "s")}${fig(by("page"), "p")}${fig(by("card"), "c")}</section>
  <footer>Generated ${escapeHtml(generatedAt.slice(0, 16).replace("T", " "))} UTC by aida proof · change the look in aida.config's brand (or brand.md), then run aida proof again.</footer>
  </body></html>`;
}
