// Shared types for the pdf module: renders a walkthrough's published page (and the whole
// manual, and a one-page quick-reference card) to PDF with Playwright Chromium, from a
// self-contained print HTML document built off the page's own Markdown — no running Next
// server required (AGENTS.md "hosts only run `next build`"; docs/scope.md "Printable guides").
import type { PrintFigure } from "../pages/types.js";

export type { PrintFigure };

export interface PdfPaperSettings {
  /** "A4" or "Letter". Default "A4". */
  paper: "A4" | "Letter";
}

/** Brand carried into the print HTML — same source as the help app's theme (config.brand).
 * `resolveArtifactBrand(config)` (render/brand.ts) returns a full one; every field is optional so
 * older hand-built brands (`{ primaryColor, logoPath, font }`) keep working. */
export interface PdfBrand {
  /** Product name for the cover, headers and the card strip. */
  name?: string;
  /** CSS colour value (or bare HSL triplet) — legacy alias for `colors.primary`. */
  primaryColor?: string;
  colors?: Partial<import("../render/brand.js").ArtifactColors>;
  /** Absolute path to the logo for light backgrounds. */
  logoPath?: string;
  /** Absolute path to the logo for dark backgrounds (cover band). */
  logoDarkPath?: string;
  /** Pre-inlined (downscaled) `data:` URLs for the two logos — build.ts fills these in once per
   * run so every page/header reuses one small image instead of the original file. */
  logoSrc?: string;
  logoDarkSrc?: string;
  font?: string;
  headingFont?: string;
  /** https stylesheet loading `font`/`headingFont`. */
  fontUrl?: string;
  /** Local `@font-face` rules for `fontUrl`'s cached static font files (fonts.ts) — filled in by
   * build.ts's `prepareBrand`; when set, the print HTML uses these instead of `fontUrl`. */
  fontFaceCss?: string;
  configured?: boolean;
}

export interface BuildPdfOptions {
  /** Absolute dir PDFs are written to — usually `<outDir>/pdf`. */
  pdfDir: string;
  paper?: "A4" | "Letter";
  brand?: PdfBrand;
  /** Force regeneration even if the cache says nothing changed. */
  force?: boolean;
  /** Allow an `http(s):`/`data:` image src in a walkthrough's Markdown through to the rendered
   * PDF. Default false — this HTML is loaded by Chromium straight off `file://`, so by default
   * only a relative path inside the page's own directory is accepted (review finding
   * pdf/markdown.ts:17); set true only when the config explicitly opts into remote images. */
  allowRemoteImages?: boolean;
  /** Public help-site root (e.g. `https://help.example.com`). When set, each guide gets a QR
   * code linking to its page there (and so its video). Unset: no QR code. */
  siteUrl?: string;
  /** Where downloaded brand font files are cached. Default `.aida-cache/fonts` (fonts.ts). */
  fontCacheDir?: string;
}

export interface PdfBuildResult {
  id: string;
  /** `<pdfDir>/<id>.pdf` */
  file: string;
  /** `<pdfDir>/<id>.card.pdf` */
  cardFile: string;
  skipped: boolean;
  /** True if this walkthrough's page wasn't publishable, so no PDFs were (re)written. */
  excluded: boolean;
  bytes?: number;
  cardBytes?: number;
}

export interface ManualBuildResult {
  /** `<pdfDir>/manual.pdf` */
  file: string;
  skipped: boolean;
  pageCount?: number;
  included: string[];
}

/** Input to one walkthrough's PDF build: everything build.ts needs, already loaded by the
 * pipeline/CLI so this module never touches the walkthrough loader or capture manifests itself. */
export interface PdfPageInput {
  id: string;
  title: string;
  /** The walkthrough's `product` — wins over the brand name in headers when set. */
  product?: string;
  /** Library section (walkthrough `section:`), used to group the manual's contents. */
  section?: string;
  summary?: string;
  for?: string;
  /** Plain Markdown with aida's generated-block markers already stripped (pages' index.plain.md). */
  markdown: string;
  /** Directory the Markdown's relative image paths (`screenshots/step-NN.png`) resolve against. */
  baseDir: string;
  lastChecked?: string;
  passed: boolean;
  publishable: boolean;
  /** Short per-step lines for the quick-reference card: caption or first sentence of page_text. */
  cardSteps: CardStepInput[];
  /** Print figures from pages (`BuildPageResult.printFigures`): clean screenshots, focus crops
   * and target boxes. Absent for pages built before M32 — the site screenshots are used then. */
  figures?: PrintFigure[];
  /** The guide's path on the help site (`/how-do-i/payments/record-a-payment`), for its QR code. */
  sitePath?: string;
}

export interface CardStepInput {
  number: number;
  title: string;
  /** Caption or first sentence of page_text — kept short for the one-page card. */
  text: string;
  /** Absolute path to the step's screenshot, if any. Used for cache fingerprinting (cache.ts)
   * and as a fallback if no downscaled thumbnail could be made. */
  screenshot?: string;
  /** Downscaled `data:image/jpeg;...` thumbnail for the quick-reference card (thumbnail.ts),
   * built from `screenshot` but far smaller — keeps the card well under the 1.78 MB it used to
   * be when it embedded full-size capture screenshots (build-plan.md M12/M16). Undefined when no
   * screenshot exists or its thumbnail failed to render; the card then shows no image for that
   * step rather than falling back to the full-size original. */
  thumbnailSrc?: string;
  /** The step's print figure, when pages made one: the card shows its focus crop. */
  figure?: PrintFigure;
}
