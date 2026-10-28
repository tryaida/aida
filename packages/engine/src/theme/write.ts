// Turns `config.brand` into the help app's generated theme files (Contract 2 in the brand
// brief): `<helpApp>/app/brand.css`, `<helpApp>/lib/brand.json` and `<helpApp>/public/brand/*`
// (copied logo/logo-dark/icon plus `theme.json` for the drop-in chat widget).
// Called by `aida init`, `aida theme` and every `aida build` with `config.helpApp` set.
//
// Deterministic (same brand -> byte-identical files) and write-if-changed, so `next dev`
// doesn't hot-reload on a no-op rebuild. Fills gaps with derivations rather than leaving
// fumadocs' neutral greys: readable text on the primary, a lighter primary for dark mode, tinted
// dark surfaces when the app only has a light palette (never the light canvas copied into dark).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { BrandColors, BrandConfig } from "../config/types.js";
import { deriveDarkColor, formatHsl, isReadable, parseColor, readableForeground, rgbToHsl, tintedDark, toCssColor } from "./color.js";
import { googleFontsUrl, isGoogleFont } from "./fonts.js";
import { withAppBrand } from "./app-brand.js";
import { readBrandNotes, resolveBrandStyle, type BrandStyle } from "./style.js";

/** What the theme writer needs from a config — a `ResolvedConfig` satisfies it. */
export interface ThemeSource {
  brand?: BrandConfig;
  /** Directory the config file lives in; brand.logo/logoDark/icon are relative to it. */
  configDir: string;
}

/** `<helpApp>/lib/brand.json` (Contract 2). Asset fields are site URLs under `/brand/`. */
export interface BrandJson {
  name: string;
  logo: string | null;
  logoDark: string | null;
  icon: string | null;
  fontUrl: string | null;
  /** True when the logo is a wordmark (much wider than tall, so it already spells the name): the
   * site shows it on its own instead of the logo followed by the name again. */
  logoWide?: boolean;
  /** House style preset (theme/style.ts) — the site and Studio frame screenshots to match. */
  style?: BrandStyle;
}

/** `<helpApp>/public/brand/theme.json` — light-theme values, CSS-ready, fetched cross-origin by
 * the drop-in chat widget (public/widget.js) to style itself on the customer's app. */
export interface WidgetThemeJson {
  name: string;
  primary: string;
  primaryForeground: string;
  logo: string | null;
  fontFamily: string | null;
}

export interface WriteThemeResult {
  /** Every file the theme owns now (absolute paths): brand.css, brand.json, public/brand/*. */
  files: string[];
  /** The subset whose content actually changed on disk this run. */
  written: string[];
  /** Stale `public/brand/{logo,logo-dark,icon}.*` files deleted. */
  removed: string[];
  /** Non-fatal problems, e.g. a logo path that doesn't exist. */
  warnings: string[];
}

export const DEFAULT_BRAND_PRIMARY = "hsl(235 55% 42%)";
export const DEFAULT_BRAND_RADIUS = "0.625rem";
const SYSTEM_STACK = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const ASSET_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif"]);
const ASSET_KINDS = [
  { field: "logo", base: "logo" },
  { field: "logoDark", base: "logo-dark" },
  { field: "icon", base: "icon" },
] as const;

/** Width over height from which a logo counts as a wordmark (logoWide). */
export const WORDMARK_ASPECT = 2.2;

/** Width over height of a PNG or SVG logo, from its header or viewBox/size attributes; undefined
 * for other formats or when it can't tell. */
export function imageAspect(bytes: Buffer, ext: string): number | undefined {
  if (ext === ".png" && bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
    const w = bytes.readUInt32BE(16);
    const h = bytes.readUInt32BE(20);
    return w > 0 && h > 0 ? w / h : undefined;
  }
  if (ext === ".svg") {
    const tag = bytes.toString("utf8", 0, Math.min(bytes.length, 4096)).match(/<svg\b[^>]*>/i)?.[0];
    if (!tag) return undefined;
    const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return Number(vb[1]) / Number(vb[2]);
    const w = Number(tag.match(/\swidth\s*=\s*["']([\d.]+)(px)?["']/i)?.[1]);
    const h = Number(tag.match(/\sheight\s*=\s*["']([\d.]+)(px)?["']/i)?.[1]);
    return w > 0 && h > 0 ? w / h : undefined;
  }
  return undefined;
}

type VarList = Array<[name: string, value: string] | null>;

/** Rejects values that would break out of a declaration (`;`, braces, `</`). */
function safe(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (!v || /[;{}]|<\//.test(v)) return undefined;
  return v;
}

function color(value: string | undefined): string | undefined {
  const v = safe(value);
  return v ? toCssColor(v) : undefined;
}

function quoteFamily(family: string): string {
  return `"${family.replace(/["\\;{}]/g, "").trim()}"`;
}

/** Light colours with `primaryColor`/`accentColor` winning over `colors.*`. */
export function lightColors(brand: BrandConfig | undefined): BrandColors {
  const c: BrandColors = { ...(brand?.colors ?? {}) };
  if (brand?.primaryColor) c.primary = brand.primaryColor;
  if (brand?.accentColor) c.accent = brand.accentColor;
  return c;
}

/** Stylesheet URL for the brand font: `fontUrl`, else a Google Fonts css2 URL when `font`
 * (and `headingFont`) are known Google families. */
export function brandFontUrl(brand: BrandConfig | undefined): string | undefined {
  if (brand?.fontUrl) return brand.fontUrl;
  const families = [brand?.font, brand?.headingFont].filter((f): f is string => !!f && isGoogleFont(f));
  return families.length > 0 ? googleFontsUrl(families) : undefined;
}

/** Readable `fg` on `bg`: the configured one when it passes `min`, else derived. */
function foregroundOn(bg: string, configured: string | undefined, min: number): string {
  if (configured && isReadable(configured, bg, min)) return configured;
  return readableForeground(bg);
}

function surfaces(c: {
  background?: string;
  foreground?: string;
  card?: string;
  muted?: string;
  mutedForeground?: string;
  border?: string;
}): VarList {
  return [
    c.background ? ["--color-fd-background", c.background] : null,
    c.foreground ? ["--color-fd-foreground", c.foreground] : null,
    c.card ? ["--color-fd-card", c.card] : null,
    c.card && c.foreground ? ["--color-fd-card-foreground", c.foreground] : null,
    c.card ? ["--color-fd-popover", c.card] : null,
    c.card && c.foreground ? ["--color-fd-popover-foreground", c.foreground] : null,
    c.muted ? ["--color-fd-muted", c.muted] : null,
    c.mutedForeground ? ["--color-fd-muted-foreground", c.mutedForeground] : null,
    c.border ? ["--color-fd-border", c.border] : null,
    c.muted ? ["--color-fd-secondary", c.muted] : null,
    c.muted && c.foreground ? ["--color-fd-secondary-foreground", c.foreground] : null,
  ];
}

/** A card surface slightly lighter than `background` (white stays white). */
function liftCard(background: string): string {
  const c = parseColor(background);
  if (!c) return "color-mix(in oklab, var(--color-fd-background) 60%, white)";
  const hsl = rgbToHsl(c);
  if (hsl.l >= 99.5) return background;
  return formatHsl({ h: hsl.h, s: hsl.s, l: Math.min(100, hsl.l + (100 - hsl.l) * 0.6) });
}

/** The `--font-sans` value for a brand (system stack when no font is set). */
export function brandFontFamily(brand: BrandConfig | undefined): string {
  const font = safe(brand?.font);
  return font ? `${quoteFamily(font)}, ${SYSTEM_STACK}` : SYSTEM_STACK;
}

/** CSS custom properties for `:root` (light) and `.dark`, in a fixed order. */
export function brandThemeVars(brand: BrandConfig | undefined): { light: Array<[string, string]>; dark: Array<[string, string]> } {
  const lc = lightColors(brand);
  const dc = brand?.dark ?? {};

  // Light theme.
  const primary = color(lc.primary) ?? DEFAULT_BRAND_PRIMARY;
  const primaryFg = foregroundOn(primary, color(lc.primaryForeground), 3);
  const accent = color(lc.accent);
  const background = color(lc.background);
  let foreground = color(lc.foreground);
  if (background && foreground && !isReadable(foreground, background)) foreground = readableForeground(background);
  const font = safe(brand?.font);
  const headingFont = safe(brand?.headingFont);
  // Cards a touch lighter than a canvas we set ourselves; with no canvas, fumadocs' defaults stay.
  const card = color(lc.card) ?? (background ? liftCard(background) : undefined);

  const light: VarList = [
    ["--brand-primary", primary],
    ["--brand-primary-foreground", primaryFg],
    ["--brand-accent", accent ?? "var(--brand-primary)"],
    ["--brand-radius", safe(brand?.radius) ?? DEFAULT_BRAND_RADIUS],
    ["--font-sans", brandFontFamily(brand)],
    ["--font-heading", headingFont ? `${quoteFamily(headingFont)}, var(--font-sans)` : "var(--font-sans)"],
    ...surfaces({
      background,
      foreground,
      card,
      muted: color(lc.muted),
      mutedForeground: color(lc.mutedForeground),
      border: color(lc.border),
    }),
    ["--color-fd-primary", "var(--brand-primary)"],
    ["--color-fd-primary-foreground", "var(--brand-primary-foreground)"],
    ["--color-fd-accent", "color-mix(in oklab, var(--brand-primary) 10%, var(--color-fd-background))"],
    ["--color-fd-accent-foreground", "var(--color-fd-foreground)"],
    ["--color-fd-ring", "var(--brand-primary)"],
  ];

  // Dark theme: explicit `brand.dark` values, else derived — never the light surfaces.
  const darkPrimary = color(dc.primary) ?? deriveDarkColor(primary);
  const darkPrimaryFg = foregroundOn(darkPrimary, color(dc.primaryForeground), 3);
  const darkAccent = color(dc.accent) ?? (accent ? deriveDarkColor(accent) : undefined);
  // Only tint dark surfaces when the app has a light palette of its own; otherwise fumadocs'
  // neutral dark greys stay (already readable).
  const tint = lc.background || lc.card ? primary : undefined;
  const darkBg = color(dc.background) ?? (tint ? tintedDark(tint, 7, 25) : undefined);
  let darkFg = color(dc.foreground);
  if (darkBg && darkFg && !isReadable(darkFg, darkBg)) darkFg = readableForeground(darkBg);
  const darkMutedFg = color(dc.mutedForeground);

  const dark: VarList = [
    ["--brand-primary", darkPrimary],
    ["--brand-primary-foreground", darkPrimaryFg],
    ["--brand-accent", darkAccent ?? "var(--brand-primary)"],
    ...surfaces({
      background: darkBg,
      foreground: darkFg,
      card: color(dc.card) ?? (tint ? tintedDark(tint, 10, 25) : undefined),
      muted: color(dc.muted) ?? (tint ? tintedDark(tint, 15, 22) : undefined),
      mutedForeground: darkMutedFg,
      border: color(dc.border) ?? (tint ? tintedDark(tint, 20, 20) : undefined),
    }),
    ["--color-fd-primary", "var(--brand-primary)"],
    ["--color-fd-primary-foreground", "var(--brand-primary-foreground)"],
    ["--color-fd-accent", "color-mix(in oklab, var(--brand-primary) 16%, var(--color-fd-background))"],
    ["--color-fd-accent-foreground", "var(--color-fd-foreground)"],
    ["--color-fd-ring", "var(--brand-primary)"],
  ];

  const compact = (l: VarList) => l.filter((e): e is [string, string] => e !== null);
  return { light: compact(light), dark: compact(dark) };
}

function block(selector: string, vars: Array<[string, string]>): string {
  const brandVars = vars.filter(([n]) => !n.startsWith("--color-fd-"));
  const fdVars = vars.filter(([n]) => n.startsWith("--color-fd-"));
  const lines = brandVars.map(([n, v]) => `  ${n}: ${v};`);
  if (fdVars.length > 0) {
    lines.push("");
    lines.push(...fdVars.map(([n, v]) => `  ${n}: ${v};`));
  }
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

/** The full `app/brand.css` text for a brand (deterministic; no `@import`). */
export function renderBrandCss(brand: BrandConfig | undefined): string {
  const { light, dark } = brandThemeVars(brand);
  const header = `/*
 * Generated by aida from aida.config's \`brand\` — \`aida theme\` (and every \`aida build\`)
 * rewrites this file. Change colours in aida.config, not here.
 */
`;
  // `:root.dark` / `:root.dark #nd-sidebar` outrank fumadocs' own `.dark` and
  // `.dark #nd-sidebar` rules regardless of stylesheet order.
  return `${header}${block(":root", light)}\n${block(".dark,\n:root.dark,\n:root.dark #nd-sidebar", dark)}`;
}

function writeIfChanged(file: string, content: string | Buffer): boolean {
  const next = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (existsSync(file)) {
    try {
      if (readFileSync(file).equals(next)) return false;
    } catch {
      // fall through and write
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}

/**
 * Writes `<helpAppDir>/app/brand.css`, `<helpAppDir>/lib/brand.json`,
 * `<helpAppDir>/public/brand/theme.json`, and copies logo/logoDark/icon into
 * `<helpAppDir>/public/brand/` (`logo.<ext>`, `logo-dark.<ext>`, `icon.<ext>`), removing stale ones. Files whose content is unchanged are left untouched.
 */
export function writeHelpAppTheme(sourceIn: ThemeSource, helpAppDir: string): WriteThemeResult {
  // The running app's brand (`aida theme --from-app`, brand/from-app.json) merged under the config.
  const source = withAppBrand(sourceIn);
  const brand = source.brand;
  const files: string[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  const brandDir = join(helpAppDir, "public", "brand");

  const json: BrandJson = {
    name: brand?.name?.trim() || "Help",
    logo: null,
    logoDark: null,
    icon: null,
    fontUrl: brandFontUrl(brand) ?? null,
    style: resolveBrandStyle(brand, readBrandNotes({ configDir: source.configDir, brand })).style,
  };

  const keep = new Set<string>();
  for (const { field, base } of ASSET_KINDS) {
    const rel = brand?.[field];
    if (!rel) continue;
    const src = isAbsolute(rel) ? rel : resolve(source.configDir, rel);
    const ext = extname(src).toLowerCase();
    if (!existsSync(src) || !statSync(src).isFile()) {
      // Keep the copy from an earlier run (a CI checkout or fresh clone may not have the source
      // the config points at) rather than dropping the logo from the site.
      const previous = existsSync(brandDir)
        ? readdirSync(brandDir).find((f) => f.startsWith(`${base}.`) && ASSET_EXTS.has(extname(f).toLowerCase()))
        : undefined;
      warnings.push(`brand.${field}: no file at ${src}${previous ? ` — keeping public/brand/${previous}` : ""}`);
      if (previous) {
        keep.add(previous);
        files.push(join(brandDir, previous));
        json[field] = `/brand/${previous}`;
      }
      continue;
    }
    if (!ASSET_EXTS.has(ext)) {
      warnings.push(`brand.${field}: unsupported image type ${ext || "(none)"} (${src})`);
      continue;
    }
    const name = `${base}${ext}`;
    const dest = join(brandDir, name);
    keep.add(name);
    files.push(dest);
    const bytes = readFileSync(src);
    if (writeIfChanged(dest, bytes)) written.push(dest);
    json[field] = `/brand/${name}`;
    if (field === "logo") {
      const aspect = imageAspect(bytes, ext);
      if (aspect !== undefined) json.logoWide = aspect >= WORDMARK_ASPECT;
    }
  }

  if (existsSync(brandDir)) {
    for (const entry of readdirSync(brandDir).sort()) {
      if (keep.has(entry) || !/^(logo|logo-dark|icon)\.[a-z0-9]+$/i.test(entry)) continue;
      const stale = join(brandDir, entry);
      unlinkSync(stale);
      removed.push(stale);
    }
  }

  const { light } = brandThemeVars(brand);
  const lightVar = (name: string) => light.find(([n]) => n === name)?.[1] ?? "";
  const widget: WidgetThemeJson = {
    name: json.name,
    primary: lightVar("--brand-primary"),
    primaryForeground: lightVar("--brand-primary-foreground"),
    logo: json.logo,
    fontFamily: safe(brand?.font) ? brandFontFamily(brand) : null,
  };
  const widgetFile = join(brandDir, "theme.json");
  if (writeIfChanged(widgetFile, `${JSON.stringify(widget, null, 2)}\n`)) written.push(widgetFile);
  files.push(widgetFile);

  const cssFile = join(helpAppDir, "app", "brand.css");
  const jsonFile = join(helpAppDir, "lib", "brand.json");
  if (writeIfChanged(cssFile, renderBrandCss(brand))) written.push(cssFile);
  if (writeIfChanged(jsonFile, `${JSON.stringify(json, null, 2)}\n`)) written.push(jsonFile);
  files.unshift(cssFile, jsonFile);

  return { files, written, removed, warnings };
}
