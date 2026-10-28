// Builds the self-contained print HTML document(s) the pdf module renders with Playwright
// Chromium's `page.pdf()` — no running Next server needed (AGENTS.md "hosts only run `next
// build`"). Uses the same brand as the help app and the videos (config.brand, resolved by
// render/brand.ts's `resolveArtifactBrand`): colours, fonts, logo and product name.
import type { Walkthrough } from "../walkthrough/index.js";
import { stepInstruction } from "../walkthrough/describe.js";
import { NEUTRAL_COLORS, cssColor, fontStack, imageDataUrl, isWordmark, safeFontName, safeFontUrl, type ArtifactColors } from "../render/brand.js";
import { escapeHtml, markdownToHtml } from "./markdown.js";
import { guideUrl, qrSvg } from "./qr.js";
import { HeadingSlugger, stripMarkdown } from "../index-search/build.js";
import type { CardStepInput, PdfBrand, PdfPageInput, PrintFigure } from "./types.js";

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
  /** The logo is a wordmark that already spells the name, so it's shown without the name. */
  logoWide?: boolean;
  /** Local `@font-face` rules (fonts.ts) that replace `fontUrl` when its files are cached. */
  fontFaceCss?: string;
  /** House style preset: cover layout, screenshot framing, ring shape. */
  style: "minimal" | "friendly" | "bold";
  tagline?: string;
}

/** The name beside the logo, left out when the logo is a wordmark that already spells it. */
function brandName(theme: PdfTheme, name: string | undefined): string {
  if (!name || ((theme.logo || theme.logoDark) && theme.logoWide)) return "";
  return `<span>${escapeHtml(name)}</span>`;
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
    ...(isWordmark(brand?.logoPath) || isWordmark(brand?.logoDarkPath) ? { logoWide: true } : {}),
    fontFaceCss: brand?.fontFaceCss,
    style: brand?.style === "minimal" || brand?.style === "friendly" ? brand.style : "bold",
    ...(brand?.tagline ? { tagline: brand.tagline } : {}),
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
  .lede { font-size: 11.5pt; color: var(--muted-fg); }
  ${FIGURE_STYLE}
`;

/** House style presets in print (M34): screenshot framing and ring shape. `bold` frames full
 * screens in a browser bar and marks targets with corner brackets; `minimal` is a thin plain
 * frame and ring; `friendly` a soft rounded frame and a pill-shaped ring. */
const STYLE_VARIANTS = `
  .style-minimal .shot-frame { border-radius: 3pt; box-shadow: none; }
  .style-minimal .ring { border-width: 1.25pt; border-radius: 3pt; box-shadow: 0 0 0 1pt rgba(255, 255, 255, 0.92); }
  .style-minimal .pin { width: 13pt; height: 13pt; font-size: 7pt; border-width: 1pt; }
  .style-friendly .shot-frame { border: 0; border-radius: 9pt; box-shadow: 0 0 0 0.6pt rgba(15, 23, 42, 0.08), 0 2pt 9pt rgba(15, 23, 42, 0.12); }
  .style-friendly .ring { border-width: 2pt; border-radius: 999pt;
    box-shadow: 0 0 0 1.25pt rgba(255, 255, 255, 0.92), 0 0 0 4.5pt color-mix(in srgb, var(--primary) 20%, transparent); }
  .style-friendly .pin { width: 17pt; height: 17pt; font-size: 8.5pt; }
  .style-bold .ring { border: 0; border-radius: 0; box-shadow: none;
    --c: var(--primary); --l: 9pt; --w: 2pt;
    background:
      linear-gradient(var(--c), var(--c)) left top / var(--l) var(--w) no-repeat, linear-gradient(var(--c), var(--c)) left top / var(--w) var(--l) no-repeat,
      linear-gradient(var(--c), var(--c)) right top / var(--l) var(--w) no-repeat, linear-gradient(var(--c), var(--c)) right top / var(--w) var(--l) no-repeat,
      linear-gradient(var(--c), var(--c)) left bottom / var(--l) var(--w) no-repeat, linear-gradient(var(--c), var(--c)) left bottom / var(--w) var(--l) no-repeat,
      linear-gradient(var(--c), var(--c)) right bottom / var(--l) var(--w) no-repeat, linear-gradient(var(--c), var(--c)) right bottom / var(--w) var(--l) no-repeat; }
  .style-bold .pin { border-radius: 4pt; }
  .style-bold .shot-full .shot-bar { display: flex; align-items: center; gap: 1.6pt; height: 11pt; padding: 0 5pt;
    background: linear-gradient(#f3f4f6, #e7e9ed); border-bottom: 0.6pt solid #d5d8de; }
  .style-bold .shot-full .shot-bar i { width: 4pt; height: 4pt; border-radius: 50%; background: #d1d5db; }
  .style-bold .shot-full .shot-bar i:nth-child(1) { background: #f87171; }
  .style-bold .shot-full .shot-bar i:nth-child(2) { background: #fbbf24; }
  .style-bold .shot-full .shot-bar i:nth-child(3) { background: #34d399; }
`;

/** A step screenshot with its ring(s) and number drawn as vector overlays (decision 36: no
 * whole-frame dimming in print — the target gets an outline and a badge instead). */
const FIGURE_STYLE = `
  .shot { margin: 0; }
  .shot-frame { position: relative; overflow: hidden; border: 0.75pt solid var(--border); border-radius: 5pt;
    background: var(--muted); box-shadow: 0 1pt 4pt rgba(15, 23, 42, 0.08); }
  .shot-frame img { display: block; width: 100%; height: auto; margin: 0; border: 0; border-radius: 0; }
  .ring { position: absolute; border: 1.75pt solid var(--primary); border-radius: 4pt;
    box-shadow: 0 0 0 1.25pt rgba(255, 255, 255, 0.92), 0 0 0 3pt color-mix(in srgb, var(--primary) 22%, transparent); }
  .pin { position: absolute; transform: translate(-50%, -50%); width: 15pt; height: 15pt; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; background: var(--primary); color: var(--primary-fg);
    font-size: 8pt; font-weight: 800; line-height: 1; border: 1.25pt solid #fff; box-shadow: 0 0.5pt 2pt rgba(0, 0, 0, 0.35); }
  .pin.callout { width: 13pt; height: 13pt; font-size: 7pt; background: #dc2626; color: #fff; }
  .legend { margin: 4pt 0 0; padding: 0; list-style: none; font-size: 8.5pt; color: var(--muted-fg); }
  .legend li { margin: 0 0 1pt; }
  .legend b { color: #dc2626; }
  .shot-img { position: relative; }
  .shot-bar { display: none; }
  ${STYLE_VARIANTS}
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
  const bodyClass = `style-${theme.style}`;
  // Cached local font files win over the remote stylesheet: static files embed as real fonts.
  const remoteFont = theme.fontFaceCss ? undefined : theme.fontUrl;
  const fontLink = remoteFont ? `<link rel="stylesheet" href="${escapeHtml(remoteFont)}">` : "";
  const faces = theme.fontFaceCss ? `<style>${theme.fontFaceCss}</style>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta(opts.allowRemote, remoteFont)}<title>${escapeHtml(title)}</title>
    ${fontLink}${faces}<style>${BASE_STYLE(theme)}${opts.extraStyle ?? ""}</style></head><body class="${bodyClass}">${bodyHtml}</body></html>`;
}

export interface PageHtmlOptions {
  /** Public help-site root (`https://help.example.com`); adds a QR code to the guide's page. */
  siteUrl?: string;
}

const RING_PAD = 8;

/** One overlay, as percentages of the figure's frame. */
interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What a figure shows in a given mode: the image, its aspect, and where rings/pins sit. */
export interface FigureView {
  src: string;
  /** width / height */
  aspect: number;
  rings: OverlayBox[];
  callouts: { left: number; top: number; label?: string }[];
  mode: "crop" | "full";
}

const pct = (v: number): number => Math.round(Math.min(Math.max(v, 0), 100) * 100) / 100;

/** `fig` as a crop (when it has one and `mode` allows) or the full screen, with every target and
 * callout mapped into that frame's percentages. Targets fully outside a crop are dropped. */
export function figureView(fig: PrintFigure, mode: "crop" | "full"): FigureView {
  const useCrop = mode === "crop" && fig.crop && fig.cropBox;
  const frame = useCrop ? fig.cropBox! : { x: 0, y: 0, w: fig.viewport.width, h: fig.viewport.height };
  const rings: OverlayBox[] = [];
  for (const t of fig.targets) {
    const x0 = Math.max(t.x - RING_PAD, frame.x);
    const y0 = Math.max(t.y - RING_PAD, frame.y);
    const x1 = Math.min(t.x + t.w + RING_PAD, frame.x + frame.w);
    const y1 = Math.min(t.y + t.h + RING_PAD, frame.y + frame.h);
    if (x1 <= x0 || y1 <= y0) continue;
    const left = pct(((x0 - frame.x) / frame.w) * 100);
    const top = pct(((y0 - frame.y) / frame.h) * 100);
    rings.push({ left, top, width: pct(((x1 - x0) / frame.w) * 100), height: pct(((y1 - y0) / frame.h) * 100) });
  }
  const callouts = fig.callouts
    .filter((c) => c.box.x >= frame.x && c.box.y >= frame.y && c.box.x <= frame.x + frame.w && c.box.y <= frame.y + frame.h)
    .map((c) => ({ left: pct(((c.box.x - frame.x) / frame.w) * 100), top: pct(((c.box.y - frame.y) / frame.h) * 100), label: c.label }));
  return { src: useCrop ? fig.crop! : fig.full, aspect: frame.w / frame.h, rings, callouts, mode: useCrop ? "crop" : "full" };
}

/** Print shows the focus crop, except where the reader needs the whole screen to orient: the
 * guide's first step, or a step whose screen they haven't seen yet. */
export function printMode(fig: PrintFigure): "crop" | "full" {
  return fig.crop && fig.cropBox && !fig.newScreen ? "crop" : "full";
}

/** The overlays for a figure: rings, the step-number badge on the first ring, callout pins. */
export function overlayHtml(view: Pick<FigureView, "rings" | "callouts">, stepNumber?: number): string {
  const rings = view.rings
    .map((r) => `<span class="ring" style="left:${r.left}%;top:${r.top}%;width:${r.width}%;height:${r.height}%"></span>`)
    .join("");
  const first = view.rings[0];
  // Keep the badge's centre inside the frame so it's never clipped at an edge.
  const pin = first && stepNumber !== undefined
    ? `<span class="pin" style="left:${Math.min(Math.max(first.left, 3), 97)}%;top:${Math.min(Math.max(first.top, 4), 96)}%">${stepNumber}</span>`
    : "";
  const callouts = view.callouts
    .map((c, i) => `<span class="pin callout" style="left:${Math.min(Math.max(c.left, 3), 97)}%;top:${Math.min(Math.max(c.top, 4), 96)}%">${i + 1}</span>`)
    .join("");
  return rings + pin + callouts;
}

function fileUrl(file: string): string {
  return `file://${encodeURI(file)}`;
}

/** Tallest a full-screen step screenshot prints (mm): two fit on a page with their text. */
export const FULL_SHOT_MAX_MM = 88;
/** Tallest a stacked focus crop prints (mm). */
export const CROP_SHOT_MAX_MM = 78;

function figureHtml(fig: PrintFigure, stepNumber: number, layout: "split" | "stack"): string {
  const view = figureView(fig, printMode(fig));
  const maxH = view.mode === "full" ? FULL_SHOT_MAX_MM : CROP_SHOT_MAX_MM;
  const width = layout === "split" ? "100%" : `min(100%, ${Math.round(maxH * view.aspect)}mm)`;
  const labelled = fig.callouts.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => c.label);
  const legend = labelled.length > 0
    ? `<ul class="legend">${labelled.map((c) => `<li><b>${c.n}.</b> ${escapeHtml(c.label!)}</li>`).join("")}</ul>`
    : "";
  return `<figure class="shot shot-${view.mode}" style="width:${width}"><div class="shot-frame"><div class="shot-bar"><i></i><i></i><i></i></div><div class="shot-img"><img src="${fileUrl(view.src)}" alt="" />${overlayHtml(view, stepNumber)}</div></div>${legend}</figure>`;
}

/** Steps whose text is short enough to sit beside a focus crop rather than above it. */
export const SPLIT_TEXT_MAX_CHARS = 360;

/** Two columns (text | crop) for a short step with a focus crop; stacked otherwise. */
export function stepLayout(fig: PrintFigure | undefined, textChars: number): "split" | "stack" {
  return fig && printMode(fig) === "crop" && textChars <= SPLIT_TEXT_MAX_CHARS ? "split" : "stack";
}

/** True when the page's steps sit under exactly one "Part N:" chapter heading — then that
 * heading says nothing the guide's title doesn't, and print drops it (decision 36). */
export function isSinglePart(bodyHtml: string): boolean {
  return (bodyHtml.match(/<h3>Part \d+:/g) ?? []).length === 1;
}

/** One walkthrough's full page, built from its already-rendered Markdown (pages/build.ts's
 * `index.plain.md` — the generated-block markers already stripped out). `allowRemoteImages`
 * defaults to false — see `resolveImageSrc` in markdown.ts. */
export function buildPageHtml(input: PdfPageInput, brand?: PdfBrand, allowRemoteImages?: boolean, opts: PageHtmlOptions = {}): string {
  const theme = pdfTheme(brand);
  let body = markdownToHtml(input.markdown, input.baseDir, { allowRemote: allowRemoteImages });
  if (isSinglePart(body)) body = body.replace(/<h3>Part \d+:[\s\S]*?<\/h3>\s*/, "");
  const figures = new Map((input.figures ?? []).map((f) => [f.step, f] as const));
  const url = guideUrl(opts.siteUrl, input.sitePath);
  const { main, otherWays, tail } = splitOtherWays(stripHeader(body));
  const steps = wrapSteps(main, figures) + (otherWays ? otherWaysHtml(otherWays, input.pathFigures ?? {}, { guideUrl: url, pathAnchors: pathHeadingAnchors(input.markdown) }) : "") + tail.replace(PATH_CLIP_P, "");
  const html = [guideHeader(input, body, theme, url), boxSections(steps)].join("\n");
  return htmlDoc(input.title, `<main class="guide">${html}</main>`, theme, { allowRemote: allowRemoteImages, extraStyle: GUIDE_STYLE + OTHER_WAYS_STYLE });
}

const GUIDE_STYLE = `
  .guide-head { display: flex; gap: 14pt; align-items: flex-start; margin: 0 0 14pt; }
  .gh-text { flex: 1; min-width: 0; }
  .gh-eyebrow { font-size: 8pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); margin: 0 0 4pt; }
  .guide-head .lede { margin: 0 0 8pt; }
  .gh-facts { display: flex; flex-wrap: wrap; gap: 6pt; margin: 0; padding: 0; list-style: none; }
  .gh-facts li { font-size: 8.5pt; color: var(--muted-fg); background: var(--muted); border-radius: 10pt; padding: 2pt 8pt; margin: 0; }
  .gh-facts b { color: var(--fg); font-weight: 700; }
  .gh-qr { flex: none; width: 30mm; text-align: center; border: 0.75pt solid var(--border); border-radius: 5pt; padding: 3mm 3mm 2.5mm; }
  .gh-qr .qr { display: block; width: 100%; height: auto; }
  .gh-qr p { margin: 2mm 0 0; font-size: 7pt; line-height: 1.3; color: var(--muted-fg); }
  .box { break-inside: avoid; page-break-inside: avoid; border-radius: 6pt; padding: 8pt 12pt 6pt; margin: 0 0 14pt; }
  .box h2 { border: none; padding: 0; margin: 0 0 4pt; font-size: 8.5pt; letter-spacing: 0.14em; text-transform: uppercase; }
  .box ul { margin: 0 0 2pt; }
  .box-before { background: var(--primary-soft); border: 0.75pt solid var(--primary-line); border-left: 3pt solid var(--primary); }
  .box-note { background: var(--muted); border: 0.75pt solid var(--border); }
  .box-note h2 { color: var(--fg); }
  .box-note ul { columns: 2; column-gap: 18pt; }
  .box-note li { break-inside: avoid; }
  h2.steps-h { margin-top: 4pt; }
  h3 { margin-top: 10pt; }
  .step { break-inside: avoid; page-break-inside: avoid; margin: 0 0 13pt; }
  .step h4.step-h { margin: 0 0 4pt; }
  .step-text p:last-child, .step-text ul:last-child { margin-bottom: 0; }
  .step.stack .step-text { margin-left: 26pt; }
  .step.stack .step-text h4.step-h { margin-left: -26pt; }
  .step.stack .shot { margin: 6pt 0 0 26pt; max-width: calc(100% - 26pt); }
  .step.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); column-gap: 14pt; align-items: start; }
  .step.split .step-text { padding-top: 1pt; }
  .step.split .step-text p, .step.split .step-text ul { margin-left: 26pt; }
  .step blockquote { margin-left: 26pt; }
  .step.split blockquote { margin-left: 26pt; }
  .verified { margin-top: 10pt; padding-top: 6pt; border-top: 0.75pt solid var(--border); font-size: 8.5pt; color: var(--muted-fg); }
`;

/** The page's own `<h1>` and the summary paragraph straight after it. */
function headerParts(bodyHtml: string): { h1?: string; lede?: string } {
  const m = /<h1>([\s\S]*?)<\/h1>\s*(?:<p>([\s\S]*?)<\/p>)?/.exec(bodyHtml);
  return { h1: m?.[1], lede: m?.[2] };
}

function stripHeader(bodyHtml: string): string {
  return bodyHtml.replace(/<h1>[\s\S]*?<\/h1>\s*(?:<p>[\s\S]*?<\/p>)?/, "");
}

/** Title, summary, a facts row (steps, last checked) and — when the site URL is known — a QR
 * code to the guide online, where its video plays. */
function guideHeader(input: PdfPageInput, bodyHtml: string, theme: PdfTheme, url: string | undefined): string {
  const { h1, lede } = headerParts(bodyHtml);
  const eyebrow = input.section?.split("/").map((s) => s.trim()).filter(Boolean).join(" › ") || theme.name || input.product;
  const steps = input.cardSteps.length;
  const facts = [
    steps > 0 ? `<li><b>${steps}</b> step${steps === 1 ? "" : "s"}</li>` : "",
    input.lastChecked ? `<li>Checked <b>${escapeHtml(humanDate(input.lastChecked))}</b></li>` : "",
  ].join("");
  const qr = url
    ? `<div class="gh-qr">${qrSvg(url, { label: "Open this guide online" })}<p>Scan to watch the video and open this guide online</p></div>`
    : "";
  return `<header class="guide-head"><div class="gh-text">${eyebrow ? `<div class="gh-eyebrow">${escapeHtml(eyebrow)}</div>` : ""}<h1>${h1 ?? escapeHtml(input.title)}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}${facts ? `<ul class="gh-facts">${facts}</ul>` : ""}</div>${qr}</header>`;
}

/** "Before you start" and "Good to know" as tidy callout boxes; the closing "verified" line as a
 * small footnote; the "Steps" heading tagged for spacing. */
function boxSections(bodyHtml: string): string {
  return bodyHtml
    .split(/(?=<h2>)/)
    .map((part) => {
      const m = /^<h2>(Before you start|Good to know)<\/h2>/.exec(part);
      if (!m) return part.replace(/^<h2>Steps<\/h2>/, '<h2 class="steps-h">Steps</h2>');
      const cut = part.search(/<hr \/>|<h3>|<h4>/);
      const inner = cut === -1 ? part : part.slice(0, cut);
      const rest = cut === -1 ? "" : part.slice(cut);
      return `<section class="box ${m[1] === "Before you start" ? "box-before" : "box-note"}">${inner}</section>${rest}`;
    })
    .join("")
    .replace(/<hr \/>\s*<p><em>(Steps [\s\S]*?)<\/em><\/p>/, '<p class="verified">$1</p>');
}

const STEP_IMG = /<img alt="[^"]*" src="file:\/\/[^"]*?\/step-(\d+)\.png" \/>/;

/** Groups each `<h4>` step heading with everything up to the next `<h2>`/`<h3>`/`<h4>` into one
 * `break-inside: avoid` block (a step is never split from its screenshot), turns a leading "N."
 * into a brand-coloured badge, and swaps the site screenshot for the step's print figure. */
function wrapSteps(bodyHtml: string, figures: Map<number, PrintFigure>): string {
  const parts = bodyHtml.split(/(?=<h4>|<h3>|<h2>|<hr \/>)/);
  return parts
    .map((part) => {
      if (!part.startsWith("<h4>")) return part;
      const badged = part.replace(
        /^<h4>(\d+)\.\s*([\s\S]*?)<\/h4>/,
        (_m, n: string, title: string) => `<h4 class="step-h"><span class="step-num">${n}</span><span>${title}</span></h4>`,
      );
      const img = STEP_IMG.exec(badged);
      const fig = img ? figures.get(Number(img[1])) : undefined;
      const text = img ? badged.replace(img[0], "") : badged;
      const chars = text.replace(/<h4[\s\S]*?<\/h4>/, "").replace(/<[^>]+>/g, "").trim().length;
      const layout = stepLayout(fig, chars);
      const shot = fig ? figureHtml(fig, Number(img![1]), layout) : img ? `<figure class="shot" style="width:min(100%, ${Math.round(FULL_SHOT_MAX_MM * 16 / 9)}mm)"><div class="shot-frame">${img[0]}</div></figure>` : "";
      return `<div class="step ${layout}"><div class="step-text">${text.trim()}</div>${shot}</div>`;
    })
    .join("\n");
}

// ---- Other ways to do this (decision 34; build-plan.md M33) ------------------------------------
// The page's "Other ways to do this" section: per walkthrough path, its title, when to use it, the
// writer's note, its opening steps laid out like the main steps (with the path's own print
// figures) and the "Then continue from step N" line (none for a path that runs to its own end,
// decision 37). A path's heading is kept on the same page as its first step. Kept apart from the
// main step wrapping.

const OTHER_WAYS_STYLE = `
  h2.other-ways-h { margin-top: 16pt; break-after: avoid; page-break-after: avoid; }
  .path { margin: 0 0 14pt; padding: 0 0 0 12pt; border-left: 3pt solid var(--primary-line); }
  .path h3 { margin: 8pt 0 3pt; break-after: avoid; page-break-after: avoid; }
  .path-start { break-inside: avoid; page-break-inside: avoid; }
  .path-when { margin: 0 0 8pt; color: var(--muted-fg); }
  .path blockquote { margin: 0 0 8pt; }
  .path-join { break-before: avoid; page-break-before: avoid; margin: -4pt 0 0 26pt; font-weight: 600; }
  .path-join a { color: inherit; text-decoration: none; }
  .path-qr { float: right; width: 20mm; margin: 0 0 4pt 8pt; text-align: center; }
  .path-qr .qr { display: block; width: 100%; height: auto; }
  .path-qr p { margin: 1mm 0 0; font-size: 6.5pt; line-height: 1.2; color: var(--muted-fg); }
`;

/** Splits the guide body into the main part, the "Other ways to do this" section (from its `<h2>`
 * up to the closing rule before the "verified" line) and what follows. */
export function splitOtherWays(bodyHtml: string): { main: string; otherWays?: string; tail: string } {
  const start = bodyHtml.indexOf("<h2>Other ways to do this</h2>");
  if (start === -1) return { main: bodyHtml, tail: "" };
  const rest = bodyHtml.slice(start);
  const end = rest.search(/<hr \/>|<h2>(?!Other ways)/);
  return {
    main: bodyHtml.slice(0, start),
    otherWays: end === -1 ? rest : rest.slice(0, end),
    tail: end === -1 ? "" : rest.slice(end),
  };
}

/** Where a path's clip was on the page (pdf/input.ts `stripPathClips`): print shows a QR code to
 * the page there when the site URL is known, else nothing. */
export const PATH_CLIP_MARK = (pathId: string): string => `@@aida-path-clip:${pathId}@@`;
const PATH_CLIP_P = /<p>@@aida-path-clip:([a-z0-9-]+)@@<\/p>\s*/g;

/**
 * The ids the site gives each path's `### Title` under "Other ways to do this", in order: every
 * heading on the page counts toward github-slugger's repeat numbering (`-1`, `-2`), exactly as
 * index-search's `HeadingSlugger` walks a page, so a path titled like a main step still links right.
 */
export function pathHeadingAnchors(markdown: string): string[] {
  const slugger = new HeadingSlugger();
  const anchors: string[] = [];
  let inOtherWays = false;
  let inFence = false;
  for (const line of markdown.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const anchor = slugger.slug(stripMarkdown(m[2]));
    if (m[1].length === 2) inOtherWays = stripMarkdown(m[2]) === "Other ways to do this";
    else if (m[1].length === 3 && inOtherWays) anchors.push(anchor);
  }
  return anchors;
}

const PATH_STEP_IMG = /<img alt="[^"]*" src="file:\/\/[^"]*?\/paths\/([a-z0-9-]+)-step-(\d+)\.png" \/>/;

/** The "Other ways to do this" section as print HTML; see the section comment above. */
export function otherWaysHtml(
  sectionHtml: string,
  pathFigures: Record<string, PrintFigure[]>,
  opts: { guideUrl?: string; pathAnchors?: string[] } = {},
): string {
  const [heading, ...paths] = sectionHtml.split(/(?=<h3>)/);
  const out = [heading.replace("<h2>Other ways to do this</h2>", '<h2 class="other-ways-h">Other ways to do this</h2>')];
  for (const [pi, chunk] of paths.entries()) {
    const [intro, ...steps] = chunk.split(/(?=<h4>)/);
    let join = "";
    const last = steps.length > 0 ? steps.length - 1 : -1;
    const joinMatch = /<p>(Then continue from [\s\S]*?)<\/p>\s*$/;
    const fromLast = last >= 0 ? joinMatch.exec(steps[last]) : joinMatch.exec(intro);
    if (fromLast) {
      join = `<p class="path-join">${fromLast[1]}</p>`;
      if (last >= 0) steps[last] = steps[last].replace(joinMatch, "");
    }
    // A path with a clip on the site: a QR code to its place on the page (M35); print keeps the crops.
    let qr = "";
    const anchor = opts.pathAnchors?.[pi];
    const introNoClip = intro.replace(PATH_CLIP_P, (_m, id: string) => {
      if (opts.guideUrl && !qr) {
        const url = anchor ? `${opts.guideUrl}#${anchor}` : opts.guideUrl;
        qr = `<div class="path-qr">${qrSvg(url, { label: "Watch this way online" })}<p>Scan to watch this way</p></div>`;
      }
      void id;
      return "";
    });
    const head = (last >= 0 ? introNoClip : introNoClip.replace(joinMatch, "")).replace(/^(<h3>[\s\S]*?<\/h3>)\s*<p>([\s\S]*?)<\/p>/, `$1<p class="path-when">$2</p>${qr.replace(/\$/g, "$$$$")}`);
    const [first, ...rest] = steps.map((part) => pathStepHtml(part, pathFigures));
    // The heading, when-sentence, note and first step travel together: never a heading orphaned
    // at the bottom of a page.
    const start = `<div class="path-start">${head.trim()}${first ?? ""}</div>`;
    out.push(`<section class="path">${start}${rest.length > 0 ? `\n${rest.join("\n")}` : ""}${join}</section>`);
  }
  return out.join("\n");
}

/** One path step: badge, text and the path's own print figure (or its site screenshot). */
function pathStepHtml(part: string, pathFigures: Record<string, PrintFigure[]>): string {
  const badged = part.replace(
    /^<h4>(\d+)\.\s*([\s\S]*?)<\/h4>/,
    (_m, n: string, title: string) => `<h4 class="step-h"><span class="step-num">${n}</span><span>${title}</span></h4>`,
  );
  const img = PATH_STEP_IMG.exec(badged);
  const fig = img ? pathFigures[img[1]]?.find((f) => f.step === Number(img[2])) : undefined;
  const text = img ? badged.replace(img[0], "") : badged;
  const chars = text.replace(/<h4[\s\S]*?<\/h4>/, "").replace(/<[^>]+>/g, "").trim().length;
  const layout = stepLayout(fig, chars);
  const shot = fig
    ? figureHtml(fig, Number(img![2]), layout)
    : img
      ? `<figure class="shot" style="width:min(100%, ${Math.round(FULL_SHOT_MAX_MM * 16 / 9)}mm)"><div class="shot-frame">${img[0]}</div></figure>`
      : "";
  return `<div class="step ${layout}"><div class="step-text">${text.trim()}</div>${shot}</div>`;
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
  /** Absolute path of a clean full-screen app screenshot shown on the cover. */
  heroImage?: string;
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
    .hero { position: absolute; right: -14mm; top: calc(60% - 12mm); width: 122mm; margin: 0; border: 1.5mm solid #fff;
      border-radius: 4mm; box-shadow: 0 6mm 14mm rgba(15, 23, 42, 0.28), 0 0 0 0.3mm rgba(15, 23, 42, 0.08); }
    .has-hero .lede, .has-hero .facts { max-width: 72mm; }
    .has-hero .facts { flex-direction: column; gap: 6mm; }
  `;
  const hero = opts.heroImage ? `<img class="hero" src="${fileUrl(opts.heroImage)}" alt="" />` : "";
  const brandRow = name || theme.logo || theme.logoDark ? `<div class="brand">${logoOnDark(theme, "logo")}${brandName(theme, name)}</div>` : "";
  const lede = name
    ? `Step-by-step guides for everyday tasks in ${escapeHtml(name)}, with a screenshot for every step.`
    : "Step-by-step guides for everyday tasks, with a screenshot for every step.";
  const facts = [
    `<div class="fact"><span>Updated</span><strong>${escapeHtml(humanDate(date))}</strong></div>`,
    opts.guideCount !== undefined ? `<div class="fact"><span>Guides</span><strong>${opts.guideCount}</strong></div>` : "",
  ].join("");
  const body = `<div class="cover${hero ? " has-hero" : ""}">
    <div class="band">
      ${brandRow}
      <div class="titles"><div class="eyebrow">${name ? `${escapeHtml(name)} · ` : ""}Printable manual</div><h1>${escapeHtml(title)}</h1></div>
    </div>
    <div class="meta">
      <p class="lede">${lede}</p>
      <div class="facts">${facts}</div>
      <div class="foot"><span>${name ? `${escapeHtml(name)} help guide` : "Help guide"}</span><span>Generated ${escapeHtml(date)}</span></div>
    </div>
    ${hero}
  </div>`;
  if (theme.style !== "bold") return lightCoverHtml(title, date, theme, name, opts, lede, facts);
  return htmlDoc(title, body, theme, { extraStyle: style });
}

/** A logo for a light background: the light logo bare, else the dark-background one on a tile. */
function logoOnLight(theme: PdfTheme, cls: string): string {
  if (theme.logo) return `<img class="${cls}" src="${theme.logo}" alt="" />`;
  if (theme.logoDark) return `<span class="${cls}-tile"><img class="${cls}" src="${theme.logoDark}" alt="" /></span>`;
  return "";
}

/** The `minimal` and `friendly` covers: light pages. Minimal is a quiet, left-aligned title with
 * a short brand rule and a plainly framed screenshot; friendly puts the title in a rounded white
 * panel on a tinted page, the screenshot in a soft rounded frame below. */
function lightCoverHtml(title: string, date: string, theme: PdfTheme, name: string | undefined, opts: CoverOptions, lede: string, facts: string): string {
  const friendly = theme.style === "friendly";
  const style = `
    @page { margin: 0; }
    html, body { height: 100%; }
    .cover { position: relative; height: 100vh; overflow: hidden; display: flex; flex-direction: column; padding: 24mm 22mm 16mm;
      background: ${friendly
        ? "radial-gradient(120mm 100mm at 100% 100%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%), radial-gradient(130mm 100mm at 0% 0%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 70%), color-mix(in srgb, var(--primary) 7%, white)"
        : "var(--bg)"}; }
    .brand { display: flex; align-items: center; gap: 4mm; font-family: var(--heading-font); font-size: 16pt; font-weight: 800; letter-spacing: -0.01em; color: var(--fg); }
    .brand .logo { height: 12mm; width: auto; max-width: 60mm; object-fit: contain; display: block; margin: 0; border: 0; border-radius: 0; }
    .brand .logo-tile { display: inline-flex; padding: 2mm 2.5mm; background: var(--primary); border-radius: 3mm; }
    .titles { margin-top: ${friendly ? "0" : "38mm"}; max-width: 150mm; }
    .rule { width: 14mm; height: 1.2mm; border-radius: 1mm; background: var(--primary); margin-bottom: 6mm; }
    .eyebrow { font-size: 9.5pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--primary); }
    .cover h1 { color: var(--fg); font-size: ${friendly ? "38pt" : "42pt"}; line-height: 1.05; margin: 3mm 0 0; letter-spacing: -0.03em; font-weight: ${friendly ? 800 : 700}; }
    .cover h1::after { display: none; }
    .lede { font-size: 12.5pt; color: var(--muted-fg); max-width: 120mm; margin: 6mm 0 8mm; }
    .facts { display: flex; gap: 12mm; }
    .fact span { display: block; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted-fg); }
    .fact strong { display: block; margin-top: 1.2mm; font-size: 12pt; color: var(--fg); }
    .tagline { margin: 0 0 6mm; font-size: 11pt; font-style: italic; color: var(--muted-fg); }
    .panel { margin-top: 26mm; background: #fff; border-radius: 9mm; padding: 14mm 14mm 12mm; box-shadow: 0 6mm 18mm -8mm color-mix(in srgb, var(--primary) 45%, transparent), 0 0 0 0.3mm rgba(15, 23, 42, 0.05); }
    .panel .eyebrow { display: inline-block; padding: 1.6mm 4mm; border-radius: 10mm; background: color-mix(in srgb, var(--primary) 11%, white); margin-top: 8mm; }
    .hero { display: block; margin: auto 0 0; width: ${friendly ? "100%" : "132mm"}; align-self: ${friendly ? "center" : "flex-end"};
      ${friendly ? "border-radius: 5mm; box-shadow: 0 5mm 14mm -6mm rgba(15, 23, 42, 0.3), 0 0 0 1.4mm #fff;" : "margin-right: -22mm; border-radius: 2.5mm 0 0 2.5mm; border: 0.3mm solid var(--border); border-right: 0; box-shadow: 0 4mm 12mm -6mm rgba(15, 23, 42, 0.22);"} }
    .foot { margin-top: ${opts.heroImage ? "8mm" : "auto"}; display: flex; justify-content: space-between; font-size: 8.5pt; color: var(--muted-fg);
      border-top: 0.75pt solid ${friendly ? "color-mix(in srgb, var(--primary) 18%, white)" : "var(--border)"}; padding-top: 4mm; }
  `;
  const brandRow = name || theme.logo || theme.logoDark ? `<div class="brand">${logoOnLight(theme, "logo")}${brandName(theme, name)}</div>` : "";
  const eyebrow = `<div class="eyebrow">${name ? `${escapeHtml(name)} · ` : ""}Printable manual</div>`;
  const tagline = theme.tagline ? `<p class="tagline">${escapeHtml(theme.tagline)}</p>` : "";
  const text = `${friendly ? "" : '<div class="rule"></div>'}${eyebrow}<h1>${escapeHtml(title)}</h1><p class="lede">${lede}</p>${tagline}<div class="facts">${facts}</div>`;
  const hero = opts.heroImage ? `<img class="hero" src="${fileUrl(opts.heroImage)}" alt="" />` : "";
  const foot = `<div class="foot"><span>${name ? `${escapeHtml(name)} help guide` : "Help guide"}</span><span>Generated ${escapeHtml(date)}</span></div>`;
  const body = friendly
    ? `<div class="cover v-friendly"><div class="panel">${brandRow}<div class="titles">${text}</div></div>${hero}${foot}</div>`
    : `<div class="cover v-minimal">${brandRow}<div class="titles">${text}</div>${hero}${foot}</div>`;
  return htmlDoc(title, body, theme, { extraStyle: style });
}

export interface TocEntry {
  title: string;
  reader: string;
  /** Library section (walkthrough `section:`); groups the contents when present. */
  section?: string;
  /** One-line summary shown under the title. */
  summary?: string;
  /** Number of steps in the guide. */
  steps?: number;
  /** 1-based page number this walkthrough's own PDF starts on within the manual. Optional —
   * omitted when not yet known (first pass). */
  page?: number;
}

/** Table of contents grouped by library section when walkthroughs have one, else by reader
 * (docs/scope.md "Printable guides": "a full manual as one PDF" with contents "by
 * section/reader"): numbered guide cards with their summary, step count and page, then a short
 * "how to use this manual" panel so a short contents page still reads as designed. */
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
    .toc-intro { color: var(--muted-fg); margin: 0 0 14pt; max-width: 135mm; }
    .toc-section { margin: 0 0 12pt; page-break-inside: avoid; }
    .toc-section h2 { display: flex; justify-content: space-between; align-items: baseline; font-size: 9pt; text-transform: uppercase;
      letter-spacing: 0.1em; margin: 0 0 2pt; padding-bottom: 3pt; }
    .toc-section h2 small { font-size: 8pt; font-weight: 600; letter-spacing: 0.04em; text-transform: none; color: var(--muted-fg); }
    .toc-row { display: grid; grid-template-columns: 20pt minmax(0, 1fr) auto; column-gap: 8pt; align-items: start;
      padding: 7pt 0; border-bottom: 0.75pt solid var(--border); break-inside: avoid; }
    .toc-row:last-child { border-bottom: none; }
    .toc-i { width: 18pt; height: 18pt; border-radius: 5pt; background: var(--primary-soft); color: var(--primary);
      border: 0.75pt solid var(--primary-line); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 8.5pt; }
    .toc-t { font-weight: 700; font-size: 11pt; line-height: 1.3; }
    .toc-sum { margin: 1pt 0 0; font-size: 9pt; color: var(--muted-fg); line-height: 1.45; }
    .toc-meta { margin-top: 2pt; font-size: 8pt; color: var(--muted-fg); }
    .toc-n { font-weight: 800; font-size: 12pt; color: var(--primary); font-variant-numeric: tabular-nums; text-align: right; min-width: 18pt; }
    .toc-n small { display: block; font-size: 6.5pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted-fg); }
    .howto { margin-top: 16pt; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8pt; break-inside: avoid; }
    .howto div { background: var(--muted); border-radius: 6pt; padding: 8pt 10pt; font-size: 8.5pt; color: var(--muted-fg); line-height: 1.45; }
    .howto b { display: block; color: var(--fg); font-size: 9pt; margin-bottom: 2pt; }
    .howto .i { display: inline-flex; width: 13pt; height: 13pt; border-radius: 50%; background: var(--primary); color: var(--primary-fg);
      font-size: 7pt; font-weight: 800; align-items: center; justify-content: center; margin-right: 4pt; vertical-align: 1pt; }
  `;
  let index = 0;
  const sections = [...groups.entries()]
    .map(
      ([group, items]) => `<div class="toc-section"><h2><span>${escapeHtml(group)}</span><small>${items.length} guide${items.length === 1 ? "" : "s"}</small></h2>${items
        .map((it) => {
          index++;
          const meta = [it.steps ? `${it.steps} step${it.steps === 1 ? "" : "s"}` : "", it.reader && it.section?.trim() ? `For ${it.reader.charAt(0).toLowerCase()}${it.reader.slice(1)}` : ""]
            .filter(Boolean)
            .map(escapeHtml)
            .join(" · ");
          return `<div class="toc-row"><span class="toc-i">${index}</span><div><div class="toc-t">${escapeHtml(it.title)}</div>${
            it.summary ? `<p class="toc-sum">${escapeHtml(it.summary)}</p>` : ""
          }${meta ? `<div class="toc-meta">${meta}</div>` : ""}</div>${it.page ? `<span class="toc-n"><small>Page</small>${it.page}</span>` : "<span></span>"}</div>`;
        })
        .join("")}</div>`,
    )
    .join("\n");
  const howto = `<div class="howto">
    <div><b>Before you start</b>Each guide opens with who to sign in as and anything to set up first.</div>
    <div><b><span class="i">1</span>Numbered steps</b>Follow the steps in order. The number on each screenshot marks where to click or type.</div>
    <div><b>Quick reference</b>Each guide also comes as a one-page card to keep by the desk.</div>
  </div>`;
  const intro = `<p class="toc-intro">${entries.length} step-by-step guide${entries.length === 1 ? "" : "s"}${theme.name ? ` for ${escapeHtml(theme.name)}` : ""}, grouped by topic. Every step has a screenshot of the screen you'll see.</p>`;
  const body = `${theme.name ? `<div class="toc-eyebrow">${escapeHtml(theme.name)} help guide</div>` : ""}<h1>Contents</h1>${intro}${sections}${howto}`;
  return htmlDoc("Contents", body, theme, { extraStyle: style });
}

function firstSentence(text: string): string {
  const m = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

/** Short per-step line for the quick-reference card: the step's caption, or the first sentence
 * of its page text (docs/scope.md "Printable guides": "numbered steps as short lines"). */
export function cardStepsFor(wf: Pick<Walkthrough, "steps"> & Partial<Pick<Walkthrough, "data">>, screenshotFor: (stepNumber: number) => string | undefined): CardStepInput[] {
  return wf.steps.map((step, i) => {
    const stepNumber = i + 1;
    // Neither: the words its actions give (walkthrough/describe.ts), "Press **Enter**.".
    // The card prints plain text: no `**bold**` markers from page_text or the action words.
    const raw = stripMarkdown(step.caption?.trim() || firstSentence(stepInstruction(step, wf.data)));
    return {
      number: stepNumber,
      title: step.title ?? step.id ?? `Step ${stepNumber}`,
      text: raw,
      screenshot: screenshotFor(stepNumber),
    };
  });
}

export interface CardRenderOptions {
  /** Body font size, in points. Default 10 (the list fallback shrinks it to fit). */
  minFontPt?: number;
  /** Include step images; false forces the text-only list. */
  withThumbnails?: boolean;
  /** Truncate the step list to this many entries, appending "See full guide". Undefined = no truncation. */
  truncateAt?: number;
  /** Product name for the header strip when the brand doesn't carry one. */
  productName?: string;
  /** Page size the grid is sized to fill. Default "A4". */
  paper?: "A4" | "Letter";
  /** The full guide online: printed in the footer with a QR code. */
  guideUrl?: string;
}

export interface CardLayout {
  cols: number;
  rows: number;
  pages: number;
  /** Steps per page (the last page may hold fewer). */
  perPage: number;
  /** Steps shown when the guide is too long for two pages; undefined when all fit. */
  truncateAt?: number;
}

/** Grid for a quick-reference card of `n` steps with images (decision 36): one page that the
 * steps fill, large crops for short guides, two pages at most for long ones (balanced), and a
 * "See full guide" cut-off past that. */
export function cardLayout(n: number): CardLayout {
  if (n <= 3) return { cols: 1, rows: Math.max(n, 1), pages: 1, perPage: Math.max(n, 1) };
  if (n <= 8) return { cols: 2, rows: Math.ceil(n / 2), pages: 1, perPage: n };
  if (n <= 16) {
    const perPage = Math.ceil(n / 2);
    return { cols: 2, rows: Math.ceil(perPage / 2), pages: 2, perPage };
  }
  const shown = Math.min(n, 24);
  const perPage = Math.ceil(shown / 2);
  return { cols: 3, rows: Math.ceil(perPage / 3), pages: 2, perPage, ...(n > 24 ? { truncateAt: 24 } : {}) };
}

/** Printable height of a card page (mm): the paper less the card's 12mm margins, a hair under so
 * a rounding error never spills a blank page. */
function cardPageHeightMm(paper: "A4" | "Letter" = "A4"): number {
  return (paper === "Letter" ? 279.4 : 297) - 24 - 1;
}

function cardStrip(theme: PdfTheme, name: string | undefined, kind: string): string {
  return `<div class="strip"><div class="who">${logoOnDark(theme, "logo")}${brandName(theme, name)}</div><div class="kind">${kind}</div></div>`;
}

const CARD_STRIP_STYLE = `
    .strip { display: flex; align-items: center; justify-content: space-between; gap: 10pt; padding: 8pt 12pt; margin-bottom: 10pt;
      border-radius: 6pt; color: #fff;
      background: linear-gradient(120deg, color-mix(in oklab, var(--primary) 75%, var(--night)), var(--primary) 55%, color-mix(in oklab, var(--accent) 80%, var(--primary))); }
    .strip .who { display: flex; align-items: center; gap: 7pt; font-family: var(--heading-font); font-weight: 800; font-size: 12pt; }
    .strip .logo { height: 18pt; width: auto; max-width: 90pt; object-fit: contain; display: block; margin: 0; border: 0; border-radius: 0; }
    .strip .logo-tile { display: inline-flex; padding: 2pt 3pt; background: #fff; border-radius: 4pt; }
    .strip .kind { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.9; }
`;

/** Renders the quick-reference card. With step images: a grid of numbered cells (short
 * instruction + a readable focus crop) sized to fill the page (`cardLayout`). Without: the
 * text-only list, which `build.ts` shrinks/truncates until it fits one page (docs/scope.md:
 * "must fit one page (shrink text down to a floor, then truncate with 'See full guide')"). */
export function buildCardHtml(title: string, steps: CardStepInput[], brand: PdfBrand | undefined, opts: CardRenderOptions): string {
  const hasImages = opts.withThumbnails !== false && steps.some((s) => s.figure || s.thumbnailSrc);
  return hasImages ? buildCardGridHtml(title, steps, brand, opts) : buildCardListHtml(title, steps, brand, opts);
}

function cardCellImage(s: CardStepInput): string {
  if (s.figure) {
    const view = figureView(s.figure, s.figure.crop ? "crop" : "full");
    const src = s.thumbnailSrc ?? fileUrl(view.src);
    return `<div class="cell-img"><div class="frame" style="--ar:${view.aspect.toFixed(4)}"><img src="${src}" alt="" />${overlayHtml(view, s.number)}</div></div>`;
  }
  if (s.thumbnailSrc) return `<div class="cell-img"><div class="frame" style="--ar:1.7778"><img src="${s.thumbnailSrc}" alt="" /></div></div>`;
  return "";
}

function buildCardGridHtml(title: string, steps: CardStepInput[], brand: PdfBrand | undefined, opts: CardRenderOptions): string {
  const theme = pdfTheme(brand);
  const name = theme.name ?? opts.productName?.trim();
  const layout = cardLayout(steps.length);
  const shown = steps.slice(0, layout.truncateAt ?? steps.length);
  const fontPt = opts.minFontPt ?? 10;
  const pageH = cardPageHeightMm(opts.paper);
  const row = layout.cols === 1;
  const pages: CardStepInput[][] = [];
  for (let i = 0; i < shown.length; i += layout.perPage) pages.push(shown.slice(i, i + layout.perPage));
  const footNote = [
    layout.truncateAt !== undefined ? "Showing the first steps — see the full guide for every step." : "",
    opts.guideUrl ? `Full guide and video: <span class="url">${escapeHtml(opts.guideUrl.replace(/^https?:\/\//, ""))}</span>` : "",
  ].filter(Boolean).join(" ");
  const qr = opts.guideUrl ? qrSvg(opts.guideUrl, { label: "Open the full guide online" }) : "";
  const html = pages
    .map((page, p) => {
      const cells = page
        .map(
          (s) =>
            `<div class="cell${row ? " row" : ""}"><div class="cell-head"><span class="num">${s.number}</span><div class="cell-txt"><strong>${escapeHtml(s.title)}</strong>${
              s.text && s.text !== s.title ? `<span>${escapeHtml(s.text)}</span>` : ""
            }</div></div>${cardCellImage(s)}</div>`,
        )
        .join("");
      const head = p === 0
        ? `${cardStrip(theme, name, "Quick reference")}<h1 class="card-title">${escapeHtml(title)}</h1>`
        : `${cardStrip(theme, name, `Quick reference · ${escapeHtml(title)} (continued)`)}`;
      const foot = p === pages.length - 1 && (footNote || qr) ? `<div class="card-foot"><span>${footNote}</span>${qr}</div>` : "";
      return `<section class="card-page">${head}<div class="grid">${cells}</div>${foot}</section>`;
    })
    .join("");
  const style = `
    body { font-size: ${fontPt}pt; }
    ${CARD_STRIP_STYLE}
    .card-page { height: ${pageH}mm; display: flex; flex-direction: column; overflow: hidden; break-after: page; page-break-after: always; }
    .card-page:last-child { break-after: auto; page-break-after: auto; }
    .card-title { font-size: ${fontPt + 7}pt; margin: 0 0 9pt; }
    .card-title::after { margin-top: 5pt; }
    .grid { flex: 1; min-height: 0; display: grid; gap: 7pt;
      grid-template-columns: repeat(${layout.cols}, minmax(0, 1fr)); grid-template-rows: repeat(${layout.rows}, minmax(0, 1fr)); }
    .cell { min-height: 0; display: flex; flex-direction: column; gap: 5pt; padding: 7pt; border: 0.75pt solid var(--border);
      border-radius: 6pt; background: #fff; overflow: hidden; }
    .cell.row { flex-direction: row; gap: 10pt; }
    .cell.row .cell-head { width: 34%; flex: none; }
    .cell-head { display: flex; gap: 7pt; align-items: flex-start; }
    .num { flex: none; width: 17pt; height: 17pt; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      background: var(--primary); color: var(--primary-fg); font-weight: 800; font-size: ${Math.max(fontPt * 0.85, 7)}pt; }
    .cell-txt { min-width: 0; line-height: 1.35; padding-top: 1.5pt; }
    .cell-txt strong { display: block; font-size: ${fontPt + 0.5}pt; }
    .cell-txt span { color: var(--muted-fg); }
    .cell-img { flex: 1; min-height: 45%; min-width: 0; container-type: size; display: flex; align-items: center; justify-content: center; }
    .cell.row .cell-img { min-height: 0; }
    .frame { position: relative; width: min(100cqw, calc(100cqh * var(--ar))); aspect-ratio: var(--ar); overflow: hidden;
      border: 0.75pt solid var(--border); border-radius: 4pt; }
    .frame img { display: block; width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; }
    .card-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10pt; margin-top: 7pt;
      font-size: 8pt; color: var(--muted-fg); }
    .card-foot .url { color: var(--primary); font-weight: 600; }
    .card-foot .qr { width: 17mm; height: 17mm; flex: none; }
  `;
  return htmlDoc(title, html, theme, { extraStyle: style });
}

function buildCardListHtml(title: string, steps: CardStepInput[], brand: PdfBrand | undefined, opts: CardRenderOptions): string {
  const theme = pdfTheme(brand);
  const name = theme.name ?? opts.productName?.trim();
  const fontPt = opts.minFontPt ?? 10;
  const shown = opts.truncateAt !== undefined ? steps.slice(0, opts.truncateAt) : steps;
  const truncated = opts.truncateAt !== undefined && steps.length > opts.truncateAt;
  const rows = shown
    .map((s) => `<div class="card-step"><span class="num">${s.number}</span><div class="txt">${escapeHtml(s.text || s.title)}</div></div>`)
    .join("\n");
  const seeMore = truncated ? `<p class="see-more">See full guide for every step.</p>` : "";
  const numPt = Math.max(fontPt * 1.55, 12);
  const style = `
    body { font-size: ${fontPt}pt; }
    ${CARD_STRIP_STYLE}
    .card-title { font-size: ${fontPt + 7}pt; margin: 0 0 10pt; }
    .card-title::after { margin-top: 6pt; }
    .card-step { display: flex; align-items: flex-start; gap: 8pt; padding: ${Math.max(fontPt * 0.45, 2)}pt 0;
      border-bottom: 0.75pt solid var(--border); page-break-inside: avoid; }
    .card-step:last-of-type { border-bottom: none; }
    .card-step .num { flex: none; width: ${numPt}pt; height: ${numPt}pt; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
      background: var(--primary); color: var(--primary-fg); font-weight: 800; font-size: ${Math.max(fontPt * 0.85, 7)}pt; }
    .card-step .txt { flex: 1; padding-top: ${Math.max((numPt - fontPt * 1.4) / 2, 0)}pt; }
    .see-more { font-style: italic; color: var(--muted-fg); margin-top: 6pt; }
  `;
  const body = `${cardStrip(theme, name, "Quick reference")}<h1 class="card-title">${escapeHtml(title)}</h1>${rows}${seeMore}`;
  return htmlDoc(title, body, theme, { extraStyle: style });
}
