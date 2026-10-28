// One resolved brand for every artifact (narrated video, per-page PDF, manual PDF, quick-reference
// card), built from `config.brand` (the same source the help app's theme reads — Contract 1 in
// the brand builder's BrandConfig), so a video, a printed guide and the help site all look like
// the origin app. When nothing is configured, a neutral (not app-specific) look is used.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { BrandConfig } from "../config/types.js";
import { DEFAULT_BRAND_PRIMARY, WORDMARK_ASPECT, brandFontUrl, imageAspect } from "../theme/write.js";
import { isGrayish, isPale, isReadable, readableForeground, toCssColor } from "../theme/color.js";
import type { TimelineBrand } from "./types.js";
import { withAppBrand } from "../theme/app-brand.js";
import { radiusPx, readBrandNotes, resolveBrandStyle, type BrandStyle } from "../theme/style.js";

/** `config.brand` (config/types.ts, Contract 1). */
export type BrandConfigLike = BrandConfig;

/** Every colour an artifact uses, already resolved to a CSS colour value. */
export interface ArtifactColors {
  primary: string;
  primaryForeground: string;
  accent: string;
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
}

export interface ArtifactBrand {
  /** Product name, e.g. "Acme Events". Undefined when not configured (callers fall back to the
   * walkthrough's own `product`). */
  name?: string;
  colors: ArtifactColors;
  /** Body font family name (no quotes), e.g. "Inter". */
  font?: string;
  headingFont?: string;
  /** https stylesheet URL that loads `font`/`headingFont` (e.g. a Google Fonts css2 URL). */
  fontUrl?: string;
  /** Absolute path to the logo for light backgrounds. */
  logoPath?: string;
  /** Absolute path to the logo for dark backgrounds (e.g. a white logo). */
  logoDarkPath?: string;
  /** False when `config.brand` was absent — the neutral fallback look. */
  configured: boolean;
  /** House style preset (theme/style.ts): motion, callouts, covers, framing. Always set. */
  style: BrandStyle;
  /** `brand.md`'s `tagline:`, for outros and covers. */
  tagline?: string;
  /** Corner radius in px (from `brand.radius`), for frames and caption boxes. */
  radiusPx?: number;
  /** `publish.siteUrl` (http/https only): the video outro says where to find the guide. */
  siteUrl?: string;
}

function safeSiteUrl(value: string | undefined): string | undefined {
  try {
    const u = new URL(value ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback palette when nothing is configured: the help app's own default primary
 * (theme/write.ts `DEFAULT_BRAND_PRIMARY`, so an unbranded site and its artifacts still match)
 * with a sky accent — not any one product's palette. */
export const NEUTRAL_COLORS: ArtifactColors = {
  primary: DEFAULT_BRAND_PRIMARY,
  primaryForeground: "#ffffff",
  accent: "#0ea5e9",
  background: "#ffffff",
  foreground: "#0f172a",
  muted: "#f1f5f9",
  mutedForeground: "#64748b",
  border: "#e2e8f0",
};

// Anything that could break out of a CSS declaration or an HTML attribute is rejected outright.
const SAFE_CSS_VALUE = /^[#a-zA-Z0-9(),.%\s/+-]+$/;

/** Any CSS colour (hex, rgb(), hsl(), oklch(), named) or a bare shadcn HSL triplet
 * (`235 55% 42%`) -> a CSS colour value; undefined for empty/unsafe input. */
export function cssColor(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || !SAFE_CSS_VALUE.test(raw)) return undefined;
  return toCssColor(raw);
}

/** A font family name safe to drop inside double quotes in CSS. */
export function safeFontName(value: string | undefined): string | undefined {
  const raw = value?.trim().replace(/^["']|["']$/g, "");
  if (!raw || /["'<>;{}\\]/.test(raw)) return undefined;
  return raw;
}

/** Only absolute https stylesheet URLs are accepted (a print/player document must never be
 * pointed at a local file or an http origin). */
export function safeFontUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return undefined;
    if (/["'<>\s]/.test(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** CSS `font-family` stack for a brand font (or the system stack). */
export function fontStack(font: string | undefined): string {
  const system = `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  return font ? `"${font}", system-ui, ${system}` : `"Inter", system-ui, ${system}`;
}

/** `config.brand` -> the one brand every artifact renders with. Logo paths are resolved against
 * `config.configDir`. Always returns a brand (neutral defaults when nothing is configured). */
export function resolveArtifactBrand(configIn: { configDir: string; brand?: BrandConfigLike; publish?: { siteUrl?: string } }): ArtifactBrand {
  // The running app's brand (brand/from-app.json) merged under the config — same as the site.
  const config = withAppBrand(configIn);
  const b = config.brand;
  const notes = readBrandNotes(config);
  const { style, tagline } = resolveBrandStyle(b, notes);
  const siteUrl = safeSiteUrl(configIn.publish?.siteUrl);
  const extras = { style, ...(tagline ? { tagline } : {}), ...(siteUrl ? { siteUrl } : {}) };
  if (!b) return { colors: { ...NEUTRAL_COLORS }, configured: false, ...extras };
  const c = b.colors ?? {};
  const primary = cssColor(b.primaryColor) ?? cssColor(c.primary);
  // shadcn-style themes often set `accent` to a pale tint (a hover fill, not a brand colour) —
  // useless for a highlight ring or a gradient, so those fall back to the primary.
  const accentRaw = cssColor(b.accentColor) ?? cssColor(c.accent);
  const accent = accentRaw && !isPale(accentRaw) && !isGrayish(accentRaw) ? accentRaw : undefined;
  const primaryResolved = primary ?? NEUTRAL_COLORS.primary;
  const fgConfigured = cssColor(c.primaryForeground);
  const colors: ArtifactColors = {
    primary: primaryResolved,
    primaryForeground: fgConfigured && isReadable(fgConfigured, primaryResolved, 3) ? fgConfigured : readableForeground(primaryResolved),
    // A brand with only a primary colour stays monochrome rather than picking up the fallback's
    // sky accent.
    accent: accent ?? primary ?? NEUTRAL_COLORS.accent,
    background: cssColor(c.background) ?? NEUTRAL_COLORS.background,
    foreground: cssColor(c.foreground) ?? NEUTRAL_COLORS.foreground,
    muted: cssColor(c.muted) ?? NEUTRAL_COLORS.muted,
    mutedForeground: cssColor(c.mutedForeground) ?? NEUTRAL_COLORS.mutedForeground,
    border: cssColor(c.border) ?? NEUTRAL_COLORS.border,
  };
  const abs = (p?: string) => (p ? path.resolve(config.configDir, p) : undefined);
  return {
    name: b.name?.trim() || undefined,
    colors,
    font: safeFontName(b.font),
    headingFont: safeFontName(b.headingFont),
    // Same rule as the help app's theme: `fontUrl`, else a Google Fonts URL for a known family.
    fontUrl: safeFontUrl(brandFontUrl(b)),
    logoPath: abs(b.logo),
    logoDarkPath: abs(b.logoDark),
    configured: true,
    ...extras,
    ...(radiusPx(b.radius) !== undefined ? { radiusPx: radiusPx(b.radius) } : {}),
  };
}

/** Logos bigger than this aren't inlined (the player bundle and PDFs stay small). */
export const MAX_INLINE_LOGO_BYTES = 1_500_000;

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** An image file inlined as a data: URL, or undefined when missing, too big or not an image. */
export function imageDataUrl(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  const mime = MIME[path.extname(file).slice(1).toLowerCase()];
  if (!mime) return undefined;
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_INLINE_LOGO_BYTES) return undefined;
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

/** A cache-key fingerprint for a brand: the brand itself plus each logo file's size+mtime, so
 * replacing a logo in place re-renders. */
export function brandFingerprint(brand: object | undefined): unknown {
  if (!brand) return undefined;
  const b = brand as { logoPath?: string; logoDarkPath?: string };
  const fp = (f?: string) => {
    if (!f || !existsSync(f)) return undefined;
    const st = statSync(f);
    return `${st.size}:${st.mtimeMs}`;
  };
  return { ...brand, logoFile: fp(b.logoPath), logoDarkFile: fp(b.logoDarkPath) };
}

/** The video timeline's brand: name, an inlined logo for the dark title cards (logoDark
 * preferred), colours and font. `productName` (the walkthrough's `product`) wins over the
 * configured brand name. */
export function timelineBrand(brand: ArtifactBrand | undefined, productName?: string): TimelineBrand {
  const name = productName?.trim() || brand?.name || "";
  const out: TimelineBrand = { name };
  if (!brand) return out;
  const dark = imageDataUrl(brand.logoDarkPath);
  const logoSrc = dark ?? imageDataUrl(brand.logoPath);
  if (logoSrc) {
    out.logoSrc = logoSrc;
    out.logoForDark = Boolean(dark);
    if (isWordmark(dark ? brand.logoDarkPath : brand.logoPath)) out.logoWide = true;
  }
  // Light cards (minimal/friendly) want the light-background logo; only worth a second copy when
  // the dark-background one took `logoSrc`.
  const light = dark ? imageDataUrl(brand.logoPath) : undefined;
  if (light) out.logoLightSrc = light;
  out.colors = {
    primary: brand.colors.primary,
    accent: brand.colors.accent,
    primaryForeground: brand.colors.primaryForeground,
    background: brand.colors.background,
    foreground: brand.colors.foreground,
  };
  if (brand.font) out.font = brand.font;
  if (brand.headingFont) out.headingFont = brand.headingFont;
  if (brand.fontUrl) out.fontUrl = brand.fontUrl;
  out.style = brand.style;
  if (brand.tagline) out.tagline = brand.tagline;
  if (brand.radiusPx !== undefined) out.radius = Math.max(0, Math.min(24, brand.radiusPx));
  return out;
}

/** True when the logo file is much wider than tall (a wordmark that spells the name). */
export function isWordmark(file: string | undefined): boolean {
  if (!file || !existsSync(file)) return false;
  const aspect = imageAspect(readFileSync(file), path.extname(file).toLowerCase());
  return aspect !== undefined && aspect >= WORDMARK_ASPECT;
}
