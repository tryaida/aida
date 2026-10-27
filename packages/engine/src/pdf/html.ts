// Builds the self-contained print HTML document(s) the pdf module renders with Playwright
// Chromium's `page.pdf()` — no running Next server needed (AGENTS.md "hosts only run `next
// build`"). Uses the same brand as the help app and the videos (config.brand, resolved by
// render/brand.ts's `resolveArtifactBrand`): colours, fonts, logo and product name.
import type { Walkthrough } from "../walkthrough/index.js";
import { NEUTRAL_COLORS, cssColor, fontStack, imageDataUrl, safeFontName, safeFontUrl, type ArtifactColors } from "../render/brand.js";
import { escapeHtml, markdownToHtml } from "./markdown.js";
import type { CardStepInput, PdfBrand, PdfPageInput } from "./types.js";

/** Everything the print templates need from a brand, with defaults filled in. */
export interface PdfTheme {
  name?: string;
  colors: ArtifactColors;
  font?: string;
  headingFont?: string;
  fontUrl?: string;
  /** Logo for light backgrounds (data: URL). */
  logo?: string;
  /** Logo for dark backgrounds (data: URL), when the brand has one. */
  logoDark?: string;
}

/** `PdfBrand` (any vintage) -> a fully-populated theme. */
export function pdfTheme(brand?: PdfBrand): PdfTheme {
  const c = brand?.colors ?? {};
  const primary = cssColor(c.primary) ?? cssColor(brand?.primaryColor);
  const colors: ArtifactColors = {
    primary: primary ?? NEUTRAL_COLORS.primary,
    primaryForeground: cssColor(c.primaryForeground) ?? NEUTRAL_COLORS.primaryForeground,
    accent: cssColor(c.accent) ?? primary ?? NEUTRAL_COLORS.accent,
    background: cssColor(c.background) ?? NEUTRAL_COLORS.background,
    foreground: cssColor(c.foreground) ?? NEUTRAL_COLORS.foreground,
    muted: cssColor(c.muted) ?? NEUTRAL_COLORS.muted,
    mutedForeground: cssColor(c.mutedForeground) ?? NEUTRAL_COLORS.mutedForeground,
    border: cssColor(c.border) ?? NEUTRAL_COLORS.border,
  };
  return {
    name: brand?.name?.trim() || undefined,
    colors,
    font: safeFontName(brand?.font),
    headingFont: safeFontName(brand?.headingFont),
    fontUrl: safeFontUrl(brand?.fontUrl),
    logo: brand?.logoSrc ?? imageDataUrl(brand?.logoPath),
    logoDark: brand?.logoDarkSrc ?? imageDataUrl(brand?.logoDarkPath),
  };
}

/** The brand's primary colour as a CSS value (`#4338ca`, `rgb(...)`, or a bare HSL triplet like
 * `235 55% 42%` wrapped as `hsl(...)`). Neutral blue when unset. */
export function brandColor(brand?: PdfBrand): string {
  return pdfTheme(brand).colors.primary;
}

/** The light-background logo inlined as a data: URL (so header/footer templates — which Chromium
 * renders in an isolated, file://-less context — and the body both work without a server). */
export function logoDataUrl(brand?: PdfBrand): string | undefined {
  return pdfTheme(brand).logo;
}

const ROOT_VARS = (t: PdfTheme): string => `
  :root {
    --primary: ${t.colors.primary};
    --primary-fg: ${t.colors.primaryForeground};
    --accent: ${t.colors.accent};
    --fg: ${t.colors.foreground};
    --bg: ${t.colors.background};
    --muted: ${t.colors.muted};
    --muted-fg: ${t.colors.mutedForeground};
    --border: ${t.colors.border};
    --primary-soft: color-mix(in srgb, var(--primary) 7%, white);
    --primary-line: color-mix(in srgb, var(--primary) 28%, white);
    --night: color-mix(in oklab, var(--primary) 30%, hsl(228 40% 7%));
    --font: ${fontStack(t.font)};
    --heading-font: ${t.headingFont ? fontStack(t.headingFont) : "var(--font)"};
  }`;

const BASE_STYLE = (t: PdfTheme): string => `
  ${ROOT_VARS(t)}
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: var(--font);
    color: var(--fg);
    margin: 0;
    font-size: 10.5pt;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4 { font-family: var(--heading-font); line-height: 1.2; }
  h1 { font-size: 22pt; font-weight: 800; letter-spacing: -0.015em; margin: 0 0 8pt; color: var(--fg); }
  h1::after { content: ""; display: block; width: 36pt; height: 3pt; border-radius: 2pt; margin-top: 8pt;
    background: linear-gradient(90deg, var(--primary), var(--accent)); }
  h2 { font-size: 14pt; font-weight: 700; margin: 20pt 0 8pt; color: var(--primary); page-break-after: avoid;
    padding-bottom: 4pt; border-bottom: 1pt solid var(--primary-line); }
  h3 { font-size: 9.5pt; font-weight: 700; margin: 16pt 0 6pt; color: var(--accent); text-transform: uppercase;
    letter-spacing: 0.08em; page-break-after: avoid; }
  h4 { font-size: 12pt; font-weight: 700; margin: 14pt 0 4pt; page-break-after: avoid; }
  h4.step-h { display: flex; align-items: center; gap: 8pt; }
  .step-num { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18pt; height: 18pt;
    border-radius: 50%; background: var(--primary); color: var(--primary-fg); font-size: 9.5pt; font-weight: 800; }
  p { margin: 0 0 8pt; }
  ul { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin: 0 0 2pt; }
  li::marker { color: var(--primary); }
  blockquote { margin: 0 0 10pt; padding: 7pt 11pt; border-left: 3pt solid var(--primary); background: var(--primary-soft);
    border-radius: 0 4pt 4pt 0; }
  code { background: var(--muted); padding: 1pt 3pt; border-radius: 3pt; font-size: 9.5pt; }
  hr { border: none; border-top: 1pt solid var(--border); margin: 14pt 0; }
  a { color: var(--primary); text-decoration: none; }
  strong { font-weight: 700; }
  img { max-width: 100%; display: block; margin: 6pt 0 12pt; border: 0.75pt solid var(--border); border-radius: 5pt; }
  .step { page-break-inside: avoid; }
  .step p, .step ul { margin-left: 26pt; }
  .step img { margin-left: 26pt; max-width: calc(100% - 26pt); }
  .lede { font-size: 11.5pt; color: var(--muted-fg); }
`;

/** Content-Security-Policy for every print document: this HTML is loaded by Chromium straight
 * off `file://` with no server/sandbox in front of it, so an injected (or malformed-escape)
 * `<iframe>`/`<script>`/remote `<img>` would otherwise be free to load local files or reach the
 * network from inside a rendered PDF (review finding pdf/html.ts). `img-src`/`style-src` only
 * allow `https:`/`http:` when the caller explicitly opts into remote images; a brand `fontUrl`
 * adds exactly its own origin to `style-src` and `https:` to `font-src` (webfont files only). */
function cspMeta(allowRemote?: boolean, fontUrl?: string): string {
  const remote = allowRemote ? " https: http:" : "";
  const fontOrigin = fontUrl ? ` ${new URL(fontUrl).origin}` : "";
  const fontSrc = fontUrl ? " https:" : "";
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:${remote}; style-src 'unsafe-inline'${remote}${fontOrigin}; font-src file: data:${fontSrc}; frame-src 'none'; object-src 'none'; script-src 'none'; base-uri 'none';">`;
}

function htmlDoc(title: string, bodyHtml: string, theme: PdfTheme, opts: { allowRemote?: boolean; extraStyle?: string } = {}): string {
  const fontLink = theme.fontUrl ? `<link rel="stylesheet" href="${escapeHtml(theme.fontUrl)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta(opts.allowRemote, theme.fontUrl)}<title>${escapeHtml(title)}</title>
    ${fontLink}<style>${BASE_STYLE(theme)}${opts.extraStyle ?? ""}</style></head><body>${bodyHtml}</body></html>`;
}

/** One walkthrough's full page, built from its already-rendered Markdown (pages/build.ts's
 * `index.plain.md` — the generated-block markers already stripped out). `allowRemoteImages`
 * defaults to false — see `resolveImageSrc` in markdown.ts. */
export function buildPageHtml(input: PdfPageInput, brand?: PdfBrand, allowRemoteImages?: boolean): string {
  const theme = pdfTheme(brand);
  const body = markdownToHtml(input.markdown, input.baseDir, { allowRemote: allowRemoteImages });
  // Wrap each "#### N. Title" step heading + the content up to the next heading/hr in a
  // `.step` div, so Playwright never splits a step from its screenshot across a page break
  // (docs/scope.md "Printable guides": "page breaks that keep a step with its screenshot").
  const wrapped = wrapSteps(markLede(body));
  return htmlDoc(input.title, wrapped, theme, { allowRemote: allowRemoteImages });
}

/** The paragraph straight after the page's `<h1>` is its summary — set it as a lede. */
function markLede(bodyHtml: string): string {
  return bodyHtml.replace(/(<h1>[\s\S]*?<\/h1>\s*)<p>/, '$1<p class="lede">');
}

/** Groups each `<h4>...` step heading with everything up to (not including) the next `<h2>`,
 * `<h3>` or `<h4>` into a `page-break-inside: avoid` wrapper, and turns a leading "N." into a
 * brand-coloured step number badge. */
function wrapSteps(bodyHtml: string): string {
  const parts = bodyHtml.split(/(?=<h4>)/);
  return parts
    .map((part) => {
      if (!part.startsWith("<h4>")) return part;
      const badged = part.replace(
        /^<h4>(\d+)\.\s*([\s\S]*?)<\/h4>/,
        (_m, n: string, title: string) => `<h4 class="step-h"><span class="step-num">${n}</span><span>${title}</span></h4>`,
      );
      return `<div class="step">${badged}</div>`;
    })
    .join("\n");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-10-26` -> `26 October 2026`; anything else is returned as-is. */
export function humanDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** A logo for a dark band: the dark-background logo bare, else the light logo on a white tile. */
function logoOnDark(theme: PdfTheme, cls: string): string {
  if (theme.logoDark) return `<img class="${cls}" src="${theme.logoDark}" alt="" />`;
  if (theme.logo) return `<span class="${cls}-tile"><img class="${cls}" src="${theme.logo}" alt="" /></span>`;
  return "";
}

export interface CoverOptions {
  /** Number of guides in the manual, shown on the cover. */
  guideCount?: number;
  /** Product name when the brand doesn't carry one (e.g. the walkthroughs' `product`). */
  productName?: string;
}

/** The cover page for `manual.pdf`: a branded band (logo, product name, title), then the date
 * and guide count. Rendered edge-to-edge (render.ts `bleed`). */
export function buildCoverHtml(title: string, date: string, brand?: PdfBrand, opts: CoverOptions = {}): string {
  const theme = pdfTheme(brand);
  const name = theme.name ?? opts.productName?.trim();
  const style = `
    @page { margin: 0; }
    html, body { height: 100%; }
    .cover { position: relative; height: 100vh; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
    .band { position: relative; flex: 0 0 60%; padding: 26mm 22mm 20mm; color: #fff; display: flex; flex-direction: column;
      background:
        radial-gradient(120mm 90mm at 92% 100%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 70%),
        radial-gradient(140mm 100mm at 0% 0%, color-mix(in srgb, var(--primary) 70%, transparent), transparent 70%),
        linear-gradient(160deg, color-mix(in oklab, var(--primary) 60%, var(--night)), var(--night)); }
    .band::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3mm;
      background: linear-gradient(90deg, var(--primary), var(--accent)); }
    .brand { display: flex; align-items: center; gap: 5mm; font-family: var(--heading-font); font-size: 20pt; font-weight: 800; letter-spacing: -0.01em; }
    .brand .logo { height: 16mm; width: auto; max-width: 70mm; object-fit: contain; display: block; margin: 0; border: 0; border-radius: 0; }
    .brand .logo-tile { display: inline-flex; padding: 2.5mm 3mm; background: #fff; border-radius: 4mm; }
    .titles { margin-top: auto; }
    .eyebrow { font-size: 10pt; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.8; }
    .cover h1 { color: #fff; font-size: 44pt; line-height: 1.04; margin: 4mm 0 0; letter-spacing: -0.03em; }
    .cover h1::after { display: none; }
    .meta { flex: 1; padding: 16mm 22mm; display: flex; flex-direction: column; }
    .lede { font-size: 13pt; color: var(--fg); max-width: 130mm; margin: 0 0 12mm; }
    .facts { display: flex; gap: 16mm; }
    .fact span { display: block; font-size: 8pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted-fg); }
    .fact strong { display: block; margin-top: 1.5mm; font-size: 13pt; color: var(--fg); }
    .foot { margin-top: auto; display: flex; justify-content: space-between; font-size: 8.5pt; color: var(--muted-fg);
      border-top: 0.75pt solid var(--border); padding-top: 4mm; }
  `;
  const brandRow = name || theme.logo || theme.logoDark ? `<div class="brand">${logoOnDark(theme, "logo")}${name ? `<span>${escapeHtml(name)}</span>` : ""}</div>` : "";
  const lede = name
    ? `Step-by-step guides for everyday tasks in ${escapeHtml(name)}, with a screenshot for every step.`
    : "Step-by-step guides for everyday tasks, with a screenshot for every step.";
  const facts = [
    `<div class="fact"><span>Updated</span><strong>${escapeHtml(humanDate(date))}</strong></div>`,
    opts.guideCount !== undefined ? `<div class="fact"><span>Guides</span><strong>${opts.guideCount}</strong></div>` : "",
  ].join("");
  const body = `<div class="cover">
    <div class="band">
      ${brandRow}
      <div class="titles"><div class="eyebrow">${name ? `${escapeHtml(name)} · ` : ""}Printable manual</div><h1>${escapeHtml(title)}</h1></div>
    </div>
    <div class="meta">
      <p class="lede">${lede}</p>
      <div class="facts">${facts}</div>
      <div class="foot"><span>${name ? `${escapeHtml(name)} help guide` : "Help guide"}</span><span>Generated ${escapeHtml(date)}</span></div>
    </div>
  </div>`;
  return htmlDoc(title, body, theme, { extraStyle: style });
}

export interface TocEntry {
  title: string;
  reader: string;
  /** Library section (walkthrough `section:`); groups the contents when present. */
  section?: string;
  /** One-line summary shown under the title. */
  summary?: string;
  /** 1-based page number this walkthrough's own PDF starts on within the manual. Optional —
   * omitted when not yet known (first pass). */
  page?: number;
}

/** Table of contents grouped by library section when walkthroughs have one, else by reader
 * (docs/scope.md "Printable guides": "a full manual as one PDF" with contents "by
 * section/reader"). */
export function buildTocHtml(entries: TocEntry[], brand?: PdfBrand): string {
  const theme = pdfTheme(brand);
  const groups = new Map<string, TocEntry[]>();
  for (const e of entries) {
    const key = e.section?.trim() ? e.section.split("/").map((s) => s.trim()).filter(Boolean).join(" › ") : e.reader || "General";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const style = `
    .toc-eyebrow { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted-fg); margin-bottom: 2pt; }
    .toc-section { margin: 0 0 14pt; page-break-inside: avoid; }
    .toc-section h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 4pt; padding-bottom: 3pt; }
    .toc-row { display: flex; align-items: baseline; gap: 6pt; padding: 4pt 0; }
    .toc-row .t { font-weight: 600; }
    .toc-row .lead { flex: 1; border-bottom: 1pt dotted var(--border); transform: translateY(-3pt); }
    .toc-row .n { font-weight: 700; color: var(--primary); min-width: 14pt; text-align: right; font-variant-numeric: tabular-nums; }
    .toc-sum { margin: -2pt 0 2pt; font-size: 9pt; color: var(--muted-fg); }
  `;
  const sections = [...groups.entries()]
    .map(
      ([group, items]) => `<div class="toc-section"><h2>${escapeHtml(group)}</h2>${items
        .map(
          (it) =>
            `<div class="toc-row"><span class="t">${escapeHtml(it.title)}</span><span class="lead"></span>${it.page ? `<span class="n">${it.page}</span>` : ""}</div>` +
            (it.summary ? `<p class="toc-sum">${escapeHtml(it.summary)}</p>` : ""),
        )
        .join("")}</div>`,
    )
    .join("\n");
  const body = `${theme.name ? `<div class="toc-eyebrow">${escapeHtml(theme.name)} help guide</div>` : ""}<h1>Contents</h1>${sections}`;
  return htmlDoc("Contents", body, theme, { extraStyle: style });
}

function firstSentence(text: string): string {
  const m = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

/** Short per-step line for the quick-reference card: the step's caption, or the first sentence
 * of its page text (docs/scope.md "Printable guides": "numbered steps as short lines"). */
export function cardStepsFor(wf: Pick<Walkthrough, "steps">, screenshotFor: (stepNumber: number) => string | undefined): CardStepInput[] {
  return wf.steps.map((step, i) => {
    const stepNumber = i + 1;
    const raw = step.caption?.trim() || firstSentence(step.page_text?.trim() ?? "");
    return {
      number: stepNumber,
      title: step.title ?? step.id ?? `Step ${stepNumber}`,
      text: raw,
      screenshot: screenshotFor(stepNumber),
    };
  });
}

export interface CardRenderOptions {
  /** Font-size shrink floor, in points. Default 7.5. */
  minFontPt?: number;
  /** Include small thumbnails when they fit; set false once a shrink pass decides they don't. */
  withThumbnails?: boolean;
  /** Truncate the step list to this many entries, appending "See full guide". Undefined = no truncation. */
  truncateAt?: number;
  /** Product name for the header strip when the brand doesn't carry one. */
  productName?: string;
}

/** Renders the one-page quick-reference card body at a given font size / thumbnail / truncation
 * setting. `render.ts` calls this at progressively smaller settings until the rendered PDF is
 * exactly one page (docs/scope.md: "must fit one page (shrink text down to a floor, then
 * truncate with 'See full guide')"). */
export function buildCardHtml(title: string, steps: CardStepInput[], brand: PdfBrand | undefined, opts: CardRenderOptions): string {
  const theme = pdfTheme(brand);
  const name = theme.name ?? opts.productName?.trim();
  const fontPt = opts.minFontPt ?? 10;
  const shown = opts.truncateAt !== undefined ? steps.slice(0, opts.truncateAt) : steps;
  const truncated = opts.truncateAt !== undefined && steps.length > opts.truncateAt;
  const rows = shown
    .map((s) => {
      // Prefer the pre-downscaled thumbnail (thumbnail.ts) — only fall back to the full-size
      // screenshot file if no thumbnail could be made, so a thumbnail failure degrades to a
      // slightly larger card rather than a missing image.
      const thumbSrc = s.thumbnailSrc ?? (s.screenshot ? `file://${encodeURI(s.screenshot)}` : undefined);
      const thumb = opts.withThumbnails && thumbSrc ? `<img class="thumb" src="${thumbSrc}" alt="" />` : "";
      return `<div class="card-step"><span class="num">${s.number}</span><div class="txt">${escapeHtml(s.text || s.title)}</div>${thumb}</div>`;
    })
    .join("\n");
  const seeMore = truncated ? `<p class="see-more">See full guide for every step.</p>` : "";
  const numPt = Math.max(fontPt * 1.55, 12);
  const style = `
    body { font-size: ${fontPt}pt; }
    .strip { display: flex; align-items: center; justify-content: space-between; gap: 10pt; padding: 8pt 12pt; margin-bottom: 12pt;
      border-radius: 6pt; color: #fff;
      background: linear-gradient(120deg, color-mix(in oklab, var(--primary) 75%, var(--night)), var(--primary) 55%, color-mix(in oklab, var(--accent) 80%, var(--primary))); }
    .strip .who { display: flex; align-items: center; gap: 7pt; font-family: var(--heading-font); font-weight: 800; font-size: 12pt; }
    .strip .logo { height: 18pt; width: auto; max-width: 90pt; object-fit: contain; display: block; margin: 0; border: 0; border-radius: 0; }
    .strip .logo-tile { display: inline-flex; padding: 2pt 3pt; background: #fff; border-radius: 4pt; }
    .strip .kind { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.9; }
    .card-title { font-size: ${fontPt + 7}pt; margin: 0 0 10pt; }
    .card-title::after { margin-top: 6pt; }
    .card-step { display: flex; align-items: flex-start; gap: 8pt; padding: ${Math.max(fontPt * 0.45, 2)}pt 0;
      border-bottom: 0.75pt solid var(--border); page-break-inside: avoid; }
    .card-step:last-of-type { border-bottom: none; }
    .card-step .num { flex: none; width: ${numPt}pt; height: ${numPt}pt; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      background: var(--primary); color: var(--primary-fg); font-weight: 800; font-size: ${Math.max(fontPt * 0.85, 7)}pt; }
    .card-step .txt { flex: 1; padding-top: ${Math.max((numPt - fontPt * 1.4) / 2, 0)}pt; }
    .thumb { width: 64pt; height: auto; margin: 0; border-radius: 3pt; flex-shrink: 0; }
    .see-more { font-style: italic; color: var(--muted-fg); margin-top: 6pt; }
  `;
  const strip = `<div class="strip"><div class="who">${logoOnDark(theme, "logo")}${name ? `<span>${escapeHtml(name)}</span>` : ""}</div><div class="kind">Quick reference</div></div>`;
  const body = `${strip}<h1 class="card-title">${escapeHtml(title)}</h1>${rows}${seeMore}`;
  return htmlDoc(title, body, theme, { extraStyle: style });
}
