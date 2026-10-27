// Orchestrates one walkthrough's PDFs (`<id>.pdf`, `<id>.card.pdf`) and the combined
// `manual.pdf`, from already-built page input (pages/build.ts's output — this module never
// touches the walkthrough loader or capture manifests itself). See docs/scope.md "Printable
// guides" and build-plan.md M12.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { checkPersonalData, checkSecrets } from "../qa/index.js";
import { buildCardHtml, buildCoverHtml, buildPageHtml, buildTocHtml, type TocEntry } from "./html.js";
import { launchBrowser, renderHtmlToPdf, renderHtmlToPdfBytes, writePdfBytes, type PdfChromeBrand, type RenderPdfOptions } from "./render.js";
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

/** Fills in `logoSrc`/`logoDarkSrc` (downscaled) and drops an unreachable `fontUrl`, once per
 * brand object per process. */
export function prepareBrand(browser: Browser, brand: PdfBrand | undefined): Promise<PdfBrand | undefined> {
  if (!brand) return Promise.resolve(undefined);
  const key = JSON.stringify(brandFingerprint(brand));
  let p = preparedBrands.get(key);
  if (!p) {
    p = (async () => {
      const out: PdfBrand = { ...brand };
      out.logoSrc ??= await smallLogoDataUrl(browser, brand.logoPath);
      out.logoDarkSrc ??= await smallLogoDataUrl(browser, brand.logoDarkPath);
      if (out.fontUrl && !(await fontUrlReachable(browser, out.fontUrl))) delete out.fontUrl;
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
  const hash = walkthroughHash(input, paper, opts.brand);

  if (!opts.force && matchesCache([file, card], hash)) {
    return { id: input.id, file, cardFile: card, skipped: true, excluded: false };
  }

  const brand = await prepareBrand(browser, opts.brand);
  const pageHtml = buildPageHtml(input, brand, opts.allowRemoteImages);
  const thumbnails = await makeThumbnails(browser, input.cardSteps.map((s) => s.screenshot));
  const cardSteps = input.cardSteps.map((s) => ({
    ...s,
    thumbnailSrc: s.screenshot ? thumbnails.get(s.screenshot) : undefined,
  }));
  const cardHtml = await fitCardHtml(browser, { ...input, cardSteps }, brand, paper);

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

/** Cache key for one walkthrough's PDFs: its Markdown, screenshots, paper, brand (incl. the logo
 * files' size+mtime, so a replaced logo re-renders), product name and last-checked date. */
function walkthroughHash(input: PdfPageInput, paper: string, brand: PdfBrand | undefined): string {
  return pdfInputHash({
    markdown: input.markdown,
    screenshots: input.cardSteps.map((s) => s.screenshot).filter((s): s is string => Boolean(s)),
    paper,
    brand: brandFingerprint(brand),
    lastChecked: input.lastChecked,
    extra: input.product,
  });
}

/** Finds a card-HTML rendering that fits on one PDF page: full text + thumbnails, then no
 * thumbnails, then progressively smaller font down to a floor, then truncated with "See full
 * guide" (docs/scope.md: "must fit one page (shrink text down to a floor, then truncate...)"). */
async function fitCardHtml(browser: Browser, input: PdfPageInput, brand: PdfBrand | undefined, paper: "A4" | "Letter"): Promise<string> {
  const attempts: Array<{ minFontPt: number; withThumbnails: boolean; truncateAt?: number }> = [
    { minFontPt: 10, withThumbnails: true },
    { minFontPt: 10, withThumbnails: false },
    { minFontPt: 9, withThumbnails: false },
    { minFontPt: 8, withThumbnails: false },
    { minFontPt: 7.5, withThumbnails: false },
  ];
  for (const attempt of attempts) {
    const html = buildCardHtml(input.title, input.cardSteps, brand, { ...attempt, productName: input.product });
    const bytes = await renderHtmlToPdfBytes(browser, html, { paper });
    if (await pageCount(bytes) <= 1) return html;
  }
  // Still doesn't fit at the font floor: truncate the step list and append "See full guide",
  // shrinking the truncation point until it fits.
  for (let n = input.cardSteps.length - 1; n >= 1; n--) {
    const html = buildCardHtml(input.title, input.cardSteps, brand, { minFontPt: 7.5, withThumbnails: false, truncateAt: n, productName: input.product });
    const bytes = await renderHtmlToPdfBytes(browser, html, { paper });
    if (await pageCount(bytes) <= 1) return html;
  }
  // Degenerate case (even one step's title alone doesn't fit — shouldn't happen in practice):
  // render just the title and a "See full guide" note.
  return buildCardHtml(input.title, [], brand, { minFontPt: 7.5, withThumbnails: false, truncateAt: 0, productName: input.product });
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

  const hash = pdfInputHash({
    markdown: included.map((i) => `${i.id}\n${i.markdown}`).join("\n---\n"),
    screenshots: [],
    paper,
    brand: brandFingerprint(opts.brand),
    extra: included.map((i) => [i.lastChecked, i.product, i.section, i.summary]),
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

  const brand = await prepareBrand(browser, opts.brand);

  // Render each walkthrough's pages first (header + "Last checked" footer, but no per-guide page
  // numbers — the manual stamps its own below), so page numbers for the TOC are known exactly
  // before the TOC page itself is rendered. Each guide's own `<id>.pdf` isn't reused here: its
  // footer numbers restart at 1, which wouldn't match the manual's contents.
  const perWalkthrough: Buffer[] = [];
  for (const input of included) {
    const html = buildPageHtml(input, brand, opts.allowRemoteImages);
    const problems = qaScanHtml(html);
    if (problems.length > 0) {
      throw new Error(`pdf qa scan found ${problems.length} problem(s) for "${input.id}": ${problems.slice(0, 3).join("; ")}`);
    }
    perWalkthrough.push(await renderHtmlToPdfBytes(browser, html, pageRenderOptions(input, paper, brand, false)));
  }

  const productName = included.find((i) => i.product)?.product;
  const coverHtml = buildCoverHtml("Help guide", new Date().toISOString().slice(0, 10), brand, {
    guideCount: included.length,
    productName,
  });
  const coverBytes = await renderHtmlToPdfBytes(browser, coverHtml, { paper, bleed: true });
  const coverPages = await pageCount(coverBytes);

  const tocEntry = (i: PdfPageInput, page?: number): TocEntry => ({
    title: i.title,
    reader: i.for ?? "General",
    section: i.section,
    summary: i.summary,
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
  await stampPageNumbers(manual, coverPages);
  const finalBytes = Buffer.from(await manual.save());
  writePdfBytes(file, finalBytes);
  writeCacheSidecar(file, hash);

  return { file, skipped: false, pageCount: manual.getPageCount(), included: included.map((i) => i.id) };
}

/** Stamps "N / total" bottom-right on every page from `fromIndex` on (the cover stays clean),
 * level with the walkthrough pages' "Last checked" footer line. */
async function stampPageNumbers(doc: PDFDocument, fromIndex: number): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const total = pages.length;
  const mm = 72 / 25.4;
  const size = 6;
  for (let i = fromIndex; i < total; i++) {
    const page = pages[i];
    const { width } = page.getSize();
    const num = String(i + 1);
    const rest = ` / ${total}`;
    const restW = font.widthOfTextAtSize(rest, size);
    const numW = bold.widthOfTextAtSize(num, size);
    const right = width - 16 * mm;
    const y = 5.75 * mm; // baseline of the footer template line (measured against Chromium's)
    page.drawText(rest, { x: right - restW, y, size, font, color: rgb(0.392, 0.455, 0.545) });
    page.drawText(num, { x: right - restW - numW, y, size, font: bold, color: rgb(0.2, 0.255, 0.333) });
  }
}
