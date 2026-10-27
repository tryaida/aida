// Orchestrates one walkthrough's PDFs (`<id>.pdf`, `<id>.card.pdf`) and the combined
// `manual.pdf`, from already-built page input (pages/build.ts's output — this module never
// touches the walkthrough loader or capture manifests itself). See docs/scope.md "Printable
// guides" and build-plan.md M12.
import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Browser } from "playwright";
import { PDFDocument } from "pdf-lib";
import { checkPersonalData, checkSecrets } from "../qa/index.js";
import { buildCardHtml, buildCoverHtml, buildPageHtml, buildTocHtml, cardLayout, figureView, type TocEntry } from "./html.js";
import { cacheFontFaces, defaultFontCacheDir, fontFaceCss } from "./fonts.js";
import { guideUrl } from "./qr.js";
import { PDF_SIDE_MARGIN_MM, cardOverflows, launchBrowser, renderHtmlToPdf, renderHtmlToPdfBytes, writePdfBytes, type PdfChromeBrand, type RenderPdfOptions } from "./render.js";
import { pdfInputHash, matchesCache, writeCacheSidecar, deletePdfOutput } from "./cache.js";
import { makeThumbnails } from "./thumbnail.js";
import { brandFingerprint, cssColor, imageDataUrl } from "../render/brand.js";
import type { BuildPdfOptions, ManualBuildResult, PdfBrand, PdfBuildResult, PdfPageInput } from "./types.js";

export { launchBrowser };
export type { BuildPdfOptions, ManualBuildResult, PdfBrand, PdfBuildResult, PdfPageInput } from "./types.js";

/** QA gate (ground rule 3 / docs/scope.md "Safe by default"): scans the HTML a PDF is about to
 * be rendered from — not just the source Markdown — so anything the HTML step adds (brand logo
 * alt text, footer text) is covered too. Returns problems found; empty means clear to render. */
function qaScanHtml(html: string): string[] {
  // Inlined images (logo, card thumbnails) are pixels, not text — their base64 can only ever
  // produce false positives, so they're blanked before the text scan.
  const text = html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:");
  const pii = checkPersonalData(text);
  const secrets = checkSecrets(text);
  return [...pii.problems, ...secrets.problems];
}

function pdfFile(pdfDir: string, id: string): string {
  return path.join(pdfDir, `${id}.pdf`);
}
function cardFile(pdfDir: string, id: string): string {
  return path.join(pdfDir, `${id}.card.pdf`);
}

/** The `<id>.pdf`/`<id>.card.pdf` paths for a walkthrough, for callers (pipeline.ts) that need
 * to remove a stale PDF outside of `buildWalkthroughPdf` itself — e.g. a page whose QA check
 * fails *after* its PDF was already rendered this run (review finding index-stage.ts:152). */
export function pdfOutputPaths(pdfDir: string, id: string): { file: string; card: string } {
  return { file: pdfFile(pdfDir, id), card: cardFile(pdfDir, id) };
}

/** Downscales a logo file to a small PNG data: URL (transparency kept) with the already-open
 * Chromium, so the header on every page and the cover embed one small image rather than the
 * original (often a 500px+ PNG). SVGs are inlined as-is. Undefined if it can't be loaded. */
async function smallLogoDataUrl(browser: Browser, file: string | undefined, maxPx = 320): Promise<string | undefined> {
  if (!file || !existsSync(file)) return undefined;
  if (/\.svg$/i.test(file)) return imageDataUrl(file);
  const page = await browser.newPage();
  try {
    await page.goto(`file://${file}`, { waitUntil: "load" });
    return await page.evaluate((maxPx) => {
      const img = document.images[0];
      if (!img || !img.naturalWidth) return undefined;
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    }, maxPx);
  } catch {
    return undefined;
  } finally {
    await page.close();
  }
}

/** True when the brand's font stylesheet loads within a few seconds — checked once per build so
 * an offline run drops the webfont up front instead of waiting it out on every page. */
async function fontUrlReachable(browser: Browser, fontUrl: string): Promise<boolean> {
  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    return await page.evaluate(
      (href) =>
        new Promise<boolean>((resolve) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          link.onload = () => resolve(true);
          link.onerror = () => resolve(false);
          document.head.appendChild(link);
          setTimeout(() => resolve(false), 5000);
        }),
      fontUrl,
    );
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

const preparedBrands = new Map<string, Promise<PdfBrand>>();

/** Fills in `logoSrc`/`logoDarkSrc` (downscaled) and the brand font, once per brand object per
 * process: `fontUrl`'s static font files cached locally (`fontFaceCss`, embedded as real fonts —
 * fonts.ts) when they can be fetched or were before; else the remote stylesheet if reachable;
 * else no webfont at all (the system fallback). */
export function prepareBrand(browser: Browser, brand: PdfBrand | undefined, fontCacheDir?: string): Promise<PdfBrand | undefined> {
  if (!brand) return Promise.resolve(undefined);
  const key = JSON.stringify([brandFingerprint(brand), fontCacheDir]);
  let p = preparedBrands.get(key);
  if (!p) {
    p = (async () => {
      const out: PdfBrand = { ...brand };
      out.logoSrc ??= await smallLogoDataUrl(browser, brand.logoPath);
      out.logoDarkSrc ??= await smallLogoDataUrl(browser, brand.logoDarkPath);
      if (out.fontUrl && !out.fontFaceCss) {
        const faces = await cacheFontFaces(out.fontUrl, fontCacheDir ?? defaultFontCacheDir());
        if (faces) out.fontFaceCss = fontFaceCss(faces);
        else if (!(await fontUrlReachable(browser, out.fontUrl))) delete out.fontUrl;
      }
      return out;
    })();
    preparedBrands.set(key, p);
  }
  return p;
}

/** Header/footer brand for a page: product (walkthrough's `product`, else brand name), small
 * logo, primary colour, font. */
function chromeBrand(brand: PdfBrand | undefined, product?: string): PdfChromeBrand {
  return {
    name: product?.trim() || brand?.name,
    logoSrc: brand?.logoSrc,
    color: cssColor(brand?.colors?.primary) ?? cssColor(brand?.primaryColor),
    font: brand?.font,
  };
}

function pageRenderOptions(input: PdfPageInput, paper: "A4" | "Letter", brand: PdfBrand | undefined, pageNumbers = true): RenderPdfOptions {
  return { paper, footer: { title: input.title, lastChecked: input.lastChecked, brand: chromeBrand(brand, input.product), pageNumbers } };
}

/** Builds (or skips, if the cache matches) one walkthrough's `<id>.pdf` and `<id>.card.pdf`.
 * Never renders a page whose capture didn't pass (docs/scope.md: "Never include pages with
 * passed:false") — `excluded: true`, and any PDF/card left over from an earlier, passing build
 * is deleted so `stagePdfsToHelpApp`/`buildManualPdf` can never pick up stale output for a page
 * that's no longer publishable (review finding pdf/build.ts:45). The same cleanup runs if this
 * run's HTML fails the QA scan below — a QA failure must leave nothing published, not just skip
 * writing something new. */
export async function buildWalkthroughPdf(
  input: PdfPageInput,
  opts: BuildPdfOptions,
  browser: Browser,
): Promise<PdfBuildResult & { qaProblems?: string[] }> {
  const file = pdfFile(opts.pdfDir, input.id);
  const card = cardFile(opts.pdfDir, input.id);

  if (!input.publishable || !input.passed) {
    deletePdfOutput(file);
    deletePdfOutput(card);
    return { id: input.id, file, cardFile: card, skipped: false, excluded: true };
  }

  const paper = opts.paper ?? "A4";
  // Resolved before the cache check: which font the PDFs would embed (cached files, the remote
  // stylesheet, or none when offline) is part of their cache key, so a PDF built with the
  // fallback font rebuilds once the real one is available.
  const brand = await prepareBrand(browser, opts.brand, opts.fontCacheDir);
  const hash = walkthroughHash(input, paper, opts.brand, opts.siteUrl, brand);

  if (!opts.force && matchesCache([file, card], hash)) {
    return { id: input.id, file, cardFile: card, skipped: true, excluded: false };
  }

  const pageHtml = buildPageHtml(input, brand, opts.allowRemoteImages, { siteUrl: opts.siteUrl });
  const cardSteps = await cardStepImages(browser, input.cardSteps);
  const cardHtml = await fitCardHtml(browser, { ...input, cardSteps }, brand, paper, guideUrl(opts.siteUrl, input.sitePath));

  const problems = [...qaScanHtml(pageHtml), ...qaScanHtml(cardHtml)];
  if (problems.length > 0) {
    deletePdfOutput(file);
    deletePdfOutput(card);
    throw new Error(`pdf qa scan found ${problems.length} problem(s) for "${input.id}": ${problems.slice(0, 3).join("; ")}`);
  }

  const bytes = await renderHtmlToPdf(browser, pageHtml, file, pageRenderOptions(input, paper, brand));
  const cardBytes = await renderHtmlToPdf(browser, cardHtml, card, { paper });

  writeCacheSidecar(file, hash);
  writeCacheSidecar(card, hash);

  return { id: input.id, file, cardFile: card, skipped: false, excluded: false, bytes, cardBytes };
}

/** Card images, downscaled once each (thumbnail.ts): a step's focus crop (else its clean full
 * screen) when pages made print figures, else the site screenshot. Big enough to read at the
 * card's largest cell, small enough to keep the card light. */
async function cardStepImages(browser: Browser, steps: PdfPageInput["cardSteps"]): Promise<PdfPageInput["cardSteps"]> {
  const sources = steps.map((s) => (s.figure ? figureView(s.figure, s.figure.crop ? "crop" : "full").src : s.screenshot));
  const large = cardLayout(steps.length).cols === 1;
  const thumbnails = await makeThumbnails(browser, sources, large ? 1600 : 1000, 0.86);
  return steps.map((s, i) => ({ ...s, thumbnailSrc: sources[i] ? thumbnails.get(sources[i]!) : undefined }));
}

/** Every print image a walkthrough's PDFs embed — part of their cache key. */
function figureFiles(input: PdfPageInput): string[] {
  // Main steps' figures and every path's (M33 "Other ways to do this"): a re-blurred path figure
  // must re-render the PDF too.
  const all = [...(input.figures ?? []), ...Object.values(input.pathFigures ?? {}).flat()];
  return all.flatMap((f) => [f.full, ...(f.crop ? [f.crop] : [])]);
}

/** Cache key for one walkthrough's PDFs: its Markdown, screenshots and print figures, paper,
 * brand (incl. the logo files' size+mtime, so a replaced logo re-renders), product name,
 * last-checked date and the QR target. */
export function walkthroughHash(input: PdfPageInput, paper: string, brand: PdfBrand | undefined, siteUrl?: string, prepared?: PdfBrand): string {
  return pdfInputHash({
    markdown: input.markdown,
    screenshots: [...input.cardSteps.map((s) => s.screenshot).filter((s): s is string => Boolean(s)), ...figureFiles(input)],
    paper,
    brand: brandFingerprint(brand),
    lastChecked: input.lastChecked,
    extra: [input.product, input.figures ?? null, input.pathFigures ?? null, guideUrl(siteUrl, input.sitePath) ?? null, PRINT_LAYOUT_VERSION, fontState(prepared)],
  });
}

/** Which font a prepared brand prints with: its cached local files (by content), the remote
 * stylesheet, or none (the system fallback) — part of every PDF's cache key. */
export function fontState(prepared: PdfBrand | undefined): string {
  if (prepared?.fontFaceCss) return `local:${createHash("sha256").update(prepared.fontFaceCss).digest("hex").slice(0, 16)}`;
  return prepared?.fontUrl ? "remote" : "none";
}

/** Bumped when the print layout changes, so cached PDFs from an older layout re-render. */
const PRINT_LAYOUT_VERSION = "m36";

/** Finds a card rendering that fits: the image grid on the pages `cardLayout` plans for (one,
 * or two for a long guide) with every word showing (measured — `cardOverflows`), at smaller text
 * if a cell's words overflow; else the text-only list at
 * full text, then progressively smaller font down to a floor, then truncated with "See full
 * guide" (docs/scope.md: "must fit one page (shrink text down to a floor, then truncate...)"). */
async function fitCardHtml(browser: Browser, input: PdfPageInput, brand: PdfBrand | undefined, paper: "A4" | "Letter", url?: string): Promise<string> {
  const base = { productName: input.product, paper, guideUrl: url };
  if (input.cardSteps.some((s) => s.figure || s.thumbnailSrc)) {
    const pages = cardLayout(input.cardSteps.length).pages;
    for (const minFontPt of [10, 9]) {
      const html = buildCardHtml(input.title, input.cardSteps, brand, { ...base, minFontPt, withThumbnails: true });
      // The grid clips overflow, so the page count alone can't catch cut-off text: measure it.
      if (await cardOverflows(browser, html, paper)) continue;
      if (await pageCount(await renderHtmlToPdfBytes(browser, html, { paper })) <= pages) return html;
    }
  }
  for (const minFontPt of [10, 9, 8, 7.5]) {
    const html = buildCardHtml(input.title, input.cardSteps, brand, { ...base, minFontPt, withThumbnails: false });
    if (await pageCount(await renderHtmlToPdfBytes(browser, html, { paper })) <= 1) return html;
  }
  // Still doesn't fit at the font floor: truncate the step list and append "See full guide",
  // shrinking the truncation point until it fits.
  for (let n = input.cardSteps.length - 1; n >= 1; n--) {
    const html = buildCardHtml(input.title, input.cardSteps, brand, { ...base, minFontPt: 7.5, withThumbnails: false, truncateAt: n });
    if (await pageCount(await renderHtmlToPdfBytes(browser, html, { paper })) <= 1) return html;
  }
  // Degenerate case (even one step's title alone doesn't fit — shouldn't happen in practice):
  // render just the title and a "See full guide" note.
  return buildCardHtml(input.title, [], brand, { ...base, minFontPt: 7.5, withThumbnails: false, truncateAt: 0 });
}

export async function pageCount(bytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Builds `manual.pdf`: a branded cover, table of contents (by library section, else reader),
 * then every publishable walkthrough's pages, merged in order, with manual-wide page numbers
 * stamped on every page after the cover so they match the contents. */
export async function buildManualPdf(
  inputs: PdfPageInput[],
  opts: BuildPdfOptions,
  browser: Browser,
): Promise<ManualBuildResult> {
  const paper = opts.paper ?? "A4";
  const file = path.join(opts.pdfDir, "manual.pdf");
  const included = inputs.filter((i) => i.publishable && i.passed);

  const brand = included.length > 0 ? await prepareBrand(browser, opts.brand, opts.fontCacheDir) : undefined;
  const hash = pdfInputHash({
    markdown: included.map((i) => `${i.id}\n${i.markdown}`).join("\n---\n"),
    screenshots: included.flatMap(figureFiles),
    paper,
    brand: brandFingerprint(opts.brand),
    extra: [
      included.map((i) => [i.lastChecked, i.product, i.section, i.summary, i.figures ?? null, i.pathFigures ?? null, guideUrl(opts.siteUrl, i.sitePath) ?? null]),
      PRINT_LAYOUT_VERSION,
      fontState(brand),
    ],
  });
  if (!opts.force && matchesCache([file], hash)) {
    return { file, skipped: true, included: included.map((i) => i.id) };
  }

  if (included.length === 0) {
    const manual = await PDFDocument.create();
    writeFileSync(file, Buffer.from(await manual.save()));
    writeCacheSidecar(file, hash);
    return { file, skipped: false, pageCount: 0, included: [] };
  }

  // Render each walkthrough's pages first (header + "Last checked" footer, but no per-guide page
  // numbers — the manual stamps its own below), so page numbers for the TOC are known exactly
  // before the TOC page itself is rendered. Each guide's own `<id>.pdf` isn't reused here: its
  // footer numbers restart at 1, which wouldn't match the manual's contents.
  const perWalkthrough: Buffer[] = [];
  for (const input of included) {
    const html = buildPageHtml(input, brand, opts.allowRemoteImages, { siteUrl: opts.siteUrl });
    const problems = qaScanHtml(html);
    if (problems.length > 0) {
      throw new Error(`pdf qa scan found ${problems.length} problem(s) for "${input.id}": ${problems.slice(0, 3).join("; ")}`);
    }
    perWalkthrough.push(await renderHtmlToPdfBytes(browser, html, pageRenderOptions(input, paper, brand, false)));
  }

  const productName = included.find((i) => i.product)?.product;
  // The cover shows the app itself: the first guide's opening screen, clean (no ring, blur kept).
  const heroImage = included.map((i) => i.figures?.find((f) => f.step === 1)?.full).find((f): f is string => Boolean(f && existsSync(f)));
  const coverHtml = buildCoverHtml("Help guide", new Date().toISOString().slice(0, 10), brand, {
    guideCount: included.length,
    productName,
    heroImage,
  });
  const coverBytes = await renderHtmlToPdfBytes(browser, coverHtml, { paper, bleed: true });
  const coverPages = await pageCount(coverBytes);

  const tocEntry = (i: PdfPageInput, page?: number): TocEntry => ({
    title: i.title,
    reader: i.for ?? "General",
    section: i.section,
    summary: i.summary,
    steps: i.cardSteps.length,
    page,
  });
  // First pass: build TOC without page numbers to learn its own page count, then a second pass
  // with real numbers (cover + toc + cumulative walkthrough page counts).
  const draftToc = buildTocHtml(included.map((i) => tocEntry(i)), brand);
  const draftTocBytes = await renderHtmlToPdfBytes(browser, draftToc, { paper });
  const tocPages = await pageCount(draftTocBytes);

  let cursor = coverPages + tocPages + 1;
  const entries: TocEntry[] = [];
  for (let i = 0; i < included.length; i++) {
    entries.push(tocEntry(included[i], cursor));
    cursor += await pageCount(perWalkthrough[i]);
  }
  const tocHtml = buildTocHtml(entries, brand);
  const tocBytes = await renderHtmlToPdfBytes(browser, tocHtml, { paper });

  const manual = await PDFDocument.create();
  for (const bytes of [coverBytes, tocBytes, ...perWalkthrough]) {
    const src = await PDFDocument.load(bytes);
    const pages = await manual.copyPages(src, src.getPageIndices());
    for (const p of pages) manual.addPage(p);
  }
  await stampPageNumbers(browser, manual, coverPages, paper, chromeBrand(brand).color);
  const finalBytes = Buffer.from(await manual.save());
  writePdfBytes(file, finalBytes);
  writeCacheSidecar(file, hash);

  return { file, skipped: false, pageCount: manual.getPageCount(), included: included.map((i) => i.id) };
}

/** Stamps "N / total" bottom-right on every page from `fromIndex` on (the cover stays clean),
 * level with the walkthrough pages' "Last checked" footer line. The numbers are printed by
 * Chromium on a transparent overlay page per manual page and laid over it, so — like every other
 * glyph in the manual — they're an embedded TrueType font, not pdf-lib's unembedded Helvetica. */
async function stampPageNumbers(browser: Browser, doc: PDFDocument, fromIndex: number, paper: "A4" | "Letter", color?: string): Promise<void> {
  const pages = doc.getPages();
  const total = pages.length;
  if (fromIndex >= total) return;
  const accent = color && /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(color) ? color : "#334155";
  const numbers = pages
    .slice(fromIndex)
    .map((_, i) => `<div class="pg"><span><b>${fromIndex + i + 1}</b> / ${total}</span></div>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html, body { margin: 0; background: transparent; }
    .pg { position: relative; height: 100vh; break-after: page; page-break-after: always; }
    .pg:last-child { break-after: auto; page-break-after: auto; }
    .pg span { position: absolute; right: ${PDF_SIDE_MARGIN_MM}mm; bottom: 5.45mm; font: 8px -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #64748b; }
    .pg b { color: ${accent}; font-weight: 700; }
  </style></head><body>${numbers}</body></html>`;
  const overlay = await PDFDocument.load(await renderHtmlToPdfBytes(browser, html, { paper, bleed: true, transparent: true }));
  const embedded = await doc.embedPdf(overlay, overlay.getPageIndices());
  embedded.forEach((page, i) => {
    const target = pages[fromIndex + i];
    if (!target) return;
    const { width, height } = target.getSize();
    target.drawPage(page, { x: 0, y: 0, width, height });
  });
}
