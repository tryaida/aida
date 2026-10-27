// Renders self-contained print HTML (html.ts) to PDF bytes with Playwright Chromium's
// `page.pdf()`. No running Next server is involved — `page.goto("about:blank")` then
// `page.setContent()` would refuse to load `file://` images (same issue pages/annotate.ts
// hit), so this writes the HTML to a temp file and navigates to it, exactly like annotate.ts.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { NEUTRAL_COLORS } from "../render/brand.js";

/** Brand bits for the running header/footer (Chromium renders these templates in an isolated
 * context: inline styles only, data: images only, system fonts only). */
export interface PdfChromeBrand {
  /** Product name shown top-left. */
  name?: string;
  /** Small logo as a data: URL. */
  logoSrc?: string;
  /** CSS colour for the header rule and page number. */
  color?: string;
  /** Font family name (used if installed locally; webfonts don't reach the templates). */
  font?: string;
}

export interface RenderPdfOptions {
  paper: "A4" | "Letter";
  /** When set, adds a running header (logo + product name, page title) and footer ("Last
   * checked <date>", page numbers) (docs/scope.md "Printable guides"). Omitted for the one-page
   * quick-reference card and the manual's cover/contents. */
  footer?: {
    title: string;
    lastChecked?: string;
    brand?: PdfChromeBrand;
    /** Default true. The manual turns these off and stamps manual-wide numbers instead, so the
     * numbers printed on every page match its table of contents. */
    pageNumbers?: boolean;
  };
  /** Edge-to-edge page (no margins) — the manual's cover. */
  bleed?: boolean;
  /** No page background (for an overlay laid over another page — the manual's page numbers). */
  transparent?: boolean;
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch();
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SAFE_TEMPLATE_VALUE = /^[#a-zA-Z0-9(),.%\s/+-]+$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso.slice(0, 10);
}

function templateFont(brand?: PdfChromeBrand): string {
  const f = brand?.font && !/["'<>;{}\\]/.test(brand.font) ? `'${brand.font}', ` : "";
  return `${f}-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
}

/** Horizontal inset of the header/footer content — matches the body's side margins. */
export const PDF_SIDE_MARGIN_MM = 16;

export function headerTemplate(title: string, brand?: PdfChromeBrand): string {
  const color = brand?.color && SAFE_TEMPLATE_VALUE.test(brand.color) ? brand.color : NEUTRAL_COLORS.primary;
  const logo = brand?.logoSrc?.startsWith("data:image/")
    ? `<img src="${brand.logoSrc}" style="height:11px; width:auto; max-width:60px; margin-right:5px; vertical-align:middle;">`
    : "";
  const name = brand?.name ? `<span style="font-weight:700; color:#0f172a; vertical-align:middle;">${escapeHtmlAttr(brand.name)}</span>` : "";
  return `<div style="-webkit-print-color-adjust:exact; width:100%; box-sizing:border-box; padding:0 ${PDF_SIDE_MARGIN_MM}mm;">
    <div style="display:flex; justify-content:space-between; align-items:center; padding:0 0 4px;
      font-size:8px; color:#64748b; font-family:${templateFont(brand)}; border-bottom:0.75px solid ${color};">
      <span style="display:flex; align-items:center;">${logo}${name}</span>
      <span style="max-width:60%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtmlAttr(title)}</span>
    </div>
  </div>`;
}

export function footerTemplate(title: string, lastChecked?: string, brand?: PdfChromeBrand, pageNumbers = true): string {
  const color = brand?.color && SAFE_TEMPLATE_VALUE.test(brand.color) ? brand.color : NEUTRAL_COLORS.primary;
  const checked = lastChecked ? `Last checked ${escapeHtmlAttr(shortDate(lastChecked))}` : escapeHtmlAttr(title);
  const numbers = pageNumbers
    ? `<span><span style="color:${color}; font-weight:700;" class="pageNumber"></span> / <span class="totalPages"></span></span>`
    : "<span></span>";
  return `<div style="-webkit-print-color-adjust:exact; width:100%; box-sizing:border-box; padding:0 ${PDF_SIDE_MARGIN_MM}mm; display:flex; justify-content:space-between; align-items:center;
    font-size:8px; color:#64748b; font-family:${templateFont(brand)};">
    <span>${checked}</span>${numbers}
  </div>`;
}

function pdfOptions(opts: RenderPdfOptions) {
  const f = opts.footer;
  return {
    format: opts.paper,
    printBackground: true,
    omitBackground: opts.transparent ?? false,
    displayHeaderFooter: Boolean(f),
    headerTemplate: f ? headerTemplate(f.title, f.brand) : "<span></span>",
    footerTemplate: f ? footerTemplate(f.title, f.lastChecked, f.brand, f.pageNumbers ?? true) : "<span></span>",
    margin: opts.bleed
      ? { top: "0", bottom: "0", left: "0", right: "0" }
      : f
        ? { top: "20mm", bottom: "18mm", left: `${PDF_SIDE_MARGIN_MM}mm`, right: `${PDF_SIDE_MARGIN_MM}mm` }
        : { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
  };
}

/** Loads `tmpHtml` and waits until it's safe to print: every image decoded, the brand webfont
 * stylesheet (if any) loaded and its faces ready. Font waits are capped — an unreachable font
 * host prints with the fallback font rather than failing or hanging the build. */
async function loadForPrint(page: Page, tmpHtml: string): Promise<void> {
  // `domcontentloaded`, not `load`: a remote font stylesheet that never answers must not hold up
  // (or time out) navigation. Images and fonts are awaited explicitly below.
  await page.goto(`file://${tmpHtml}`, { waitUntil: "domcontentloaded" });
  // Wait for every image (screenshots, logo) to finish loading before printing, or Chromium
  // can rasterize a blank/broken image into the PDF.
  await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
  await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).every((l) => l.sheet !== null),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
  await page.evaluate(() =>
    Promise.race([
      // Force a layout so every face the page uses starts loading, then wait for them.
      Promise.resolve(document.body?.offsetHeight).then(() => document.fonts.ready),
      new Promise((r) => setTimeout(r, 5000)),
    ]),
  );
}

/** Renders `html` to a PDF file via `browser`, returning the byte size written. Caller owns
 * the browser's lifecycle (reused across many renders — one Chromium launch per build run). */
export async function renderHtmlToPdf(browser: Browser, html: string, outFile: string, opts: RenderPdfOptions): Promise<number> {
  const bytes = await renderHtmlToPdfBytes(browser, html, opts);
  writePdfBytes(outFile, bytes);
  return bytes.length;
}

/** Renders `html` to PDF bytes without writing them — also used by the card renderer's
 * shrink/truncate loop to find a setting that fits on one page. */
export async function renderHtmlToPdfBytes(browser: Browser, html: string, opts: RenderPdfOptions): Promise<Buffer> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aida-pdf-"));
  const tmpHtml = path.join(tmpDir, "page.html");
  await writeFile(tmpHtml, html);
  const page = await browser.newPage();
  try {
    await loadForPrint(page, tmpHtml);
    return await page.pdf(pdfOptions(opts));
  } finally {
    await page.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function writePdfBytes(outFile: string, bytes: Buffer): void {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, bytes);
}

/** Printable width (CSS px at 96/in) for the card's 12mm margins. */
function cardContentWidthPx(paper: "A4" | "Letter"): number {
  return Math.floor((((paper === "Letter" ? 215.9 : 210) - 24) * 96) / 25.4);
}

/**
 * True when anything in a quick-reference card is cut off: a step's text clamped or a cell or
 * card page whose content is taller than its box. The card grid hides overflow (so its page
 * count never grows), which means only measuring the laid-out page tells whether every word
 * still shows — the card's fit loop then tries smaller text, then the text-only list.
 */
export async function cardOverflows(browser: Browser, html: string, paper: "A4" | "Letter"): Promise<boolean> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "aida-pdf-"));
  const tmpHtml = path.join(tmpDir, "card.html");
  await writeFile(tmpHtml, html);
  const page = await browser.newPage({ viewport: { width: cardContentWidthPx(paper), height: 1200 } });
  try {
    await page.emulateMedia({ media: "print" });
    await loadForPrint(page, tmpHtml);
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".cell-txt, .cell, .card-page")).some((el) => el.scrollHeight > el.clientHeight + 1),
    );
  } finally {
    await page.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}
