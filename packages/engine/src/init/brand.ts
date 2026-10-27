// Brand detection for `aida init` / `aida theme --detect` (scope.md principle 11: "theme
// pulled from the app's own colours, logo and fonts"). Reads conventional files in a
// Next.js/Tailwind repo — never writes anything — and returns a `BrandConfig` whose asset paths
// are relative to `repoDir`. Every field is optional: a repo that matches no pattern gets `{}`,
// and the theme writer (src/theme/write.ts) falls back to the template defaults.
//
// What it reads:
// - name: the root layout's `metadata.title` (tagline stripped), the web manifest's
//   `short_name`, else package.json's name prettified.
// - colours: globals.css `:root` and `.dark` blocks (also inside `@layer base { ... }`), shadcn
//   variable names, Tailwind v4 `@theme { --color-*: ... }`, with `var(--x)` resolved within the
//   file; a Tailwind v3 config's literal `primary` as a fallback. The accent is a distinct brand
//   colour (`--brand-accent`, `--<prefix>-primary`, ...), never a pale fill like shadcn's
//   `--accent` tint.
// - radius: `--radius`.
// - font: a Google Fonts `@import`/`<link>`, a `next/font/google` import, `--font-sans` / body
//   `font-family`, a Tailwind config `fontFamily`.
// - logo/logoDark/icon: image files under `public/` (and `app/icon.*`).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BrandColors, BrandConfig } from "../config/types.js";
import { isBareHslTriplet, isGrayish, isPale, parseColor, sameColor } from "../theme/color.js";
import { familiesFromGoogleFontsUrl, firstFamily, googleFontsUrl, isGoogleFont } from "../theme/fonts.js";

const CSS_CANDIDATES = [
  join("app", "globals.css"),
  join("src", "app", "globals.css"),
  join("styles", "globals.css"),
  join("src", "styles", "globals.css"),
  join("app", "global.css"),
  join("src", "app", "global.css"),
  join("styles", "global.css"),
  join("src", "index.css"),
  join("src", "styles.css"),
  join("src", "global.css"),
];

const TAILWIND_CONFIG_CANDIDATES = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];

const LAYOUT_CANDIDATES = [
  join("app", "layout.tsx"),
  join("src", "app", "layout.tsx"),
  join("app", "layout.jsx"),
  join("src", "app", "layout.jsx"),
  join("app", "layout.js"),
  join("src", "app", "layout.js"),
];

const MANIFEST_TS_CANDIDATES = [join("app", "manifest.ts"), join("src", "app", "manifest.ts"), join("app", "manifest.js")];
const MANIFEST_JSON_CANDIDATES = [
  join("public", "manifest.json"),
  join("public", "site.webmanifest"),
  join("public", "manifest.webmanifest"),
  join("app", "manifest.json"),
];

const IMAGE_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".avif"]);

function readIfExists(repoDir: string, relPath: string): string | undefined {
  const file = join(repoDir, relPath);
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function firstExisting(repoDir: string, candidates: string[]): { relPath: string; content: string } | undefined {
  for (const rel of candidates) {
    const content = readIfExists(repoDir, rel);
    if (content !== undefined) return { relPath: rel, content };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// CSS parsing: a tolerant block walker (handles nested `@layer base { :root { ... } }`, strings
// and comments) — enough for theme variables, not a full CSS parser.

export interface CssBlock {
  /** The block's prelude, e.g. `:root`, `.dark`, `@layer base`, `@theme inline`. */
  selector: string;
  /** Preludes of enclosing blocks, outermost first. */
  ancestors: string[];
  /** Declarations directly inside this block (nested blocks excluded), in source order. */
  decls: Array<[name: string, value: string]>;
}

function parseDecls(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim().replace(/\s+/g, " ");
    if (!/^-{0,2}[A-Za-z_][\w-]*$/.test(name) || !value) continue;
    out.push([name, value.replace(/\s*!important$/i, "")]);
  }
  return out;
}

/** Every `{ ... }` block in a stylesheet, with its prelude, ancestors and own declarations. */
export function parseCssBlocks(source: string): CssBlock[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const blocks: CssBlock[] = [];
  interface Frame {
    selector: string;
    chunks: string[];
    chunkStart: number;
  }
  const stack: Frame[] = [];
  let segStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = css.indexOf(ch, i + 1);
      i = end < 0 ? css.length : end;
      continue;
    }
    if (ch === "(") {
      // Skip parenthesised content (url(...;...), media queries) so `;`/`{` inside don't count.
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "(") depth++;
        else if (css[j] === ")") depth--;
        else if (css[j] === '"' || css[j] === "'") {
          const end = css.indexOf(css[j], j + 1);
          j = end < 0 ? css.length : end;
        }
        j++;
      }
      i = j - 1;
      continue;
    }
    if (ch === ";") {
      segStart = i + 1;
    } else if (ch === "{") {
      const parent = stack[stack.length - 1];
      if (parent) parent.chunks.push(css.slice(parent.chunkStart, segStart));
      stack.push({ selector: css.slice(segStart, i).trim(), chunks: [], chunkStart: i + 1 });
      segStart = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame) {
        frame.chunks.push(css.slice(frame.chunkStart, i));
        blocks.push({
          selector: frame.selector,
          ancestors: stack.map((f) => f.selector),
          decls: parseDecls(frame.chunks.join(";")),
        });
        const parent = stack[stack.length - 1];
        if (parent) parent.chunkStart = i + 1;
      }
      segStart = i + 1;
    }
  }
  return blocks;
}

type Scope = Map<string, string>;

const LIGHT_SELECTOR = /^(?::root|:host|html)$/i;
const DARK_SELECTOR = /^(?::root|html)?(?:\.dark|\[data-(?:theme|mode|color-scheme)=["']?dark["']?\]|\[class~=["']?dark["']?\])$/i;

function blockKind(block: CssBlock): "light" | "dark" | undefined {
  const darkMedia = block.ancestors.some((a) => /^@media\b.*prefers-color-scheme\s*:\s*dark/i.test(a));
  for (const a of block.ancestors) {
    if (/^@(layer|supports)\b/i.test(a)) continue;
    if (/^@media\b.*prefers-color-scheme\s*:\s*dark/i.test(a)) continue;
    return undefined; // other @media / nested selectors: not the global theme
  }
  if (/^@theme\b/i.test(block.selector)) return darkMedia ? "dark" : "light";
  const parts = block.selector.split(",").map((s) => s.trim());
  if (parts.some((p) => DARK_SELECTOR.test(p))) return "dark";
  if (parts.some((p) => LIGHT_SELECTOR.test(p))) return darkMedia ? "dark" : "light";
  return undefined;
}

/** Custom properties declared in the light (`:root`, `@theme`) and dark (`.dark`, ...) scopes. */
function themeScopes(blocks: CssBlock[]): { light: Scope; dark: Scope; hasDark: boolean } {
  const light: Scope = new Map();
  const dark: Scope = new Map();
  let hasDark = false;
  for (const block of blocks) {
    const kind = blockKind(block);
    if (!kind) continue;
    const target = kind === "light" ? light : dark;
    for (const [name, value] of block.decls) {
      if (!name.startsWith("--")) continue;
      target.set(name, value);
      if (kind === "dark") hasDark = true;
    }
  }
  return { light, dark, hasDark };
}

/** Substitutes `var(--x)` / `var(--x, fallback)` from `scope`, repeatedly (cycle-safe). */
function resolveVars(value: string, scope: Scope, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;
  let changed = false;
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (whole, name: string, fallback?: string) => {
    const v = scope.get(name);
    if (v !== undefined && !v.includes(`var(${name}`)) {
      changed = true;
      return v;
    }
    if (fallback !== undefined) {
      changed = true;
      return fallback.trim();
    }
    return whole;
  });
  return changed ? resolveVars(out, scope, depth + 1) : out;
}

const COLOR_FN = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(.*\))$/i;

/** A resolved value that's usable as a colour in config (no leftover `var()`). */
function asColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v.includes("var(")) return undefined;
  if (isBareHslTriplet(v) || COLOR_FN.test(v) || parseColor(v)) return v;
  return undefined;
}

function lookupColor(scope: Scope, names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const raw = scope.get(name);
    if (raw === undefined) continue;
    const value = asColor(resolveVars(raw, scope));
    if (value) return { name, value };
  }
  return undefined;
}

const COLOR_NAMES: Record<keyof BrandColors, string[]> = {
  primary: ["--primary", "--color-primary", "--brand-primary", "--color-brand-primary", "--brand", "--color-brand"],
  primaryForeground: ["--primary-foreground", "--color-primary-foreground"],
  accent: [],
  background: ["--background", "--color-background"],
  foreground: ["--foreground", "--color-foreground"],
  card: ["--card", "--color-card"],
  muted: ["--muted", "--color-muted"],
  mutedForeground: ["--muted-foreground", "--color-muted-foreground"],
  border: ["--border", "--color-border"],
};

/** Variable-name prefixes that are UI plumbing, not a brand palette. */
const NON_BRAND_PREFIX = /^--(?:color-)?(?:sidebar|chart|shadow|hero|tw|fd|radix|ring|input|destructive|success|warning|error|info|danger|popover|card|muted|secondary|gradient)-/i;

/** Accent candidates in priority order: explicit brand accents, then `--<prefix>-primary`,
 * `--<prefix>-accent`, then shadcn `--accent`/`--secondary` (often pale fills — filtered). */
function accentCandidates(scope: Scope): Array<{ name: string; strong: boolean }> {
  const names = [...scope.keys()];
  const out: Array<{ name: string; strong: boolean }> = [];
  const add = (name: string, strong: boolean) => {
    if (scope.has(name) && !out.some((o) => o.name === name)) out.push({ name, strong });
  };
  for (const n of ["--brand-accent", "--color-brand-accent", "--brand-secondary", "--color-brand-secondary"]) add(n, true);
  for (const n of names) if (/^--(?:color-)?[a-z][\w]*-primary$/i.test(n) && !NON_BRAND_PREFIX.test(n)) add(n, true);
  for (const n of names) if (/^--(?:color-)?[a-z][\w]*-accent$/i.test(n) && !NON_BRAND_PREFIX.test(n)) add(n, true);
  for (const n of ["--accent", "--color-accent", "--secondary", "--color-secondary"]) add(n, false);
  return out;
}

function pickAccent(scope: Scope, primary: string | undefined): { name: string; value: string } | undefined {
  for (const cand of accentCandidates(scope)) {
    const value = asColor(resolveVars(scope.get(cand.name)!, scope));
    if (!value) continue;
    if (primary && sameColor(value, primary)) continue;
    const parsed = parseColor(value);
    if (!parsed && !cand.strong) continue;
    if (parsed && (isPale(value) || isGrayish(value))) continue;
    return { name: cand.name, value };
  }
  return undefined;
}

interface CssBrand {
  colors: BrandColors;
  dark?: BrandColors;
  radius?: string;
  fontVar?: string;
  headingVar?: string;
  bodyFont?: string;
  fontImportUrl?: string;
}

function brandFromCss(source: string): CssBrand {
  const blocks = parseCssBlocks(source);
  const { light, dark, hasDark } = themeScopes(blocks);
  const colors: BrandColors = {};
  const names: Partial<Record<keyof BrandColors, string>> = {};
  for (const key of Object.keys(COLOR_NAMES) as Array<keyof BrandColors>) {
    const hit = lookupColor(light, COLOR_NAMES[key]);
    if (hit) {
      colors[key] = hit.value;
      names[key] = hit.name;
    }
  }
  const accent = pickAccent(light, colors.primary);
  if (accent) {
    colors.accent = accent.value;
    names.accent = accent.name;
  }

  let darkColors: BrandColors | undefined;
  if (hasDark) {
    const merged: Scope = new Map([...light, ...dark]);
    darkColors = {};
    for (const key of Object.keys(COLOR_NAMES) as Array<keyof BrandColors>) {
      const name = names[key];
      if (!name) continue;
      const raw = merged.get(name);
      if (raw === undefined) continue;
      const value = asColor(resolveVars(raw, merged));
      if (value && value !== colors[key]) darkColors[key] = value;
    }
    if (Object.keys(darkColors).length === 0) darkColors = undefined;
  }

  const radiusRaw = light.get("--radius");
  const radius = radiusRaw ? resolveVars(radiusRaw, light) : undefined;

  const fontVarRaw = light.get("--font-sans") ?? light.get("--font-body");
  const headingRaw = light.get("--font-heading") ?? light.get("--font-display");
  let bodyFont: string | undefined;
  for (const block of blocks) {
    if (!/^(?:body|html|:root)$/i.test(block.selector)) continue;
    for (const [name, value] of block.decls) {
      if (name === "font-family") bodyFont = firstFamily(resolveVars(value, light)) ?? bodyFont;
    }
  }

  const importMatch = source.match(/@import\s+(?:url\(\s*)?["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)/i);

  return {
    colors,
    dark: darkColors,
    radius: radius && !radius.includes("var(") ? radius : undefined,
    fontVar: fontVarRaw ? firstFamily(resolveVars(fontVarRaw, light)) : undefined,
    headingVar: headingRaw ? firstFamily(resolveVars(headingRaw, light)) : undefined,
    bodyFont,
    fontImportUrl: importMatch ? importMatch[1].replace(/&amp;/g, "&") : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Tailwind v3 config + layout fonts

/** `primary: { DEFAULT: "#4338ca" }` or `primary: "#4338ca"` — literal colours only. */
function primaryFromTailwindConfig(src: string): string | undefined {
  const block = src.match(/primary\s*:\s*\{([^}]*)\}/);
  if (block) {
    const defaultMatch = block[1].match(/DEFAULT\s*:\s*['"`]([^'"`]+)['"`]/);
    if (defaultMatch && !defaultMatch[1].includes("var(")) return defaultMatch[1];
  }
  const literal = src.match(/primary\s*:\s*['"`]([^'"`]+)['"`]/);
  if (literal && !literal[1].includes("var(")) return literal[1];
  return undefined;
}

/** `fontFamily: { sans: ['Inter', ...], heading: [...] }` -> literal families. */
function fontsFromTailwindConfig(src: string): { sans?: string; heading?: string; other?: string } {
  const ff = src.match(/fontFamily\s*:\s*\{([\s\S]*?)\}\s*,?/);
  if (!ff) return {};
  const out: { sans?: string; heading?: string; other?: string } = {};
  const entry = /['"]?([\w-]+)['"]?\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(ff[1]))) {
    const key = m[1].toLowerCase();
    const family = firstFamily(m[2].replace(/['"`]/g, (q) => (q === "`" ? '"' : q)));
    if (!family) continue;
    if (key === "sans" || key === "body") out.sans ??= family;
    else if (key === "heading" || key === "display" || key === "title") out.heading ??= family;
    else if (!/mono|code|serif/.test(key)) out.other ??= family;
  }
  return out;
}

/** `import { Inter, Geist_Mono } from "next/font/google"` -> ["Inter", "Geist Mono"]. */
function nextFontGoogleFamilies(src: string): string[] {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter((s) => /^[A-Z][A-Za-z0-9_]*$/.test(s))
    .map((s) => s.replace(/_/g, " "));
}

function googleLinkHref(src: string): string | undefined {
  const m = src.match(/href=\{?["'`](https:\/\/fonts\.googleapis\.com\/css2?\?[^"'`]+)["'`]/);
  return m ? m[1].replace(/&amp;/g, "&") : undefined;
}

// ---------------------------------------------------------------------------------------------
// Name

const GENERIC_PACKAGE_NAME = /^(?:my[-_]|create[-_]|next(?:js)?(?:[-_]app)?$|app$|web$|website$|frontend$|client$|v0[-_]|starter|template|nextjs[-_])/i;

/** "Acme Events - Show Management Platform" -> "Acme Events". */
export function stripTagline(title: string): string {
  return title.split(/\s+[-|–—:·•]\s+/)[0].trim();
}

function titleFromLayout(src: string): string | undefined {
  const start = src.search(/export\s+const\s+metadata\b[^=]*=\s*\{/);
  if (start < 0) return undefined;
  const rest = src.slice(start);
  const m = rest.match(/\btitle\s*:\s*(?:\{[^}]*?\bdefault\s*:\s*)?(['"`])((?:(?!\1)[^\n])+)\1/);
  if (!m || m[2].includes("${")) return undefined;
  return stripTagline(m[2]) || undefined;
}

function nameFromManifest(repoDir: string): string | undefined {
  const ts = firstExisting(repoDir, MANIFEST_TS_CANDIDATES);
  if (ts) {
    const short = ts.content.match(/\bshort_name\s*:\s*(['"`])([^'"`\n]+)\1/);
    if (short) return short[2].trim();
    const name = ts.content.match(/\bname\s*:\s*(['"`])([^'"`\n]+)\1/);
    if (name) return stripTagline(name[2]);
  }
  const json = firstExisting(repoDir, MANIFEST_JSON_CANDIDATES);
  if (json) {
    try {
      const m = JSON.parse(json.content) as { short_name?: string; name?: string };
      if (m.short_name?.trim()) return m.short_name.trim();
      if (m.name?.trim()) return stripTagline(m.name);
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function nameFromPackageJson(repoDir: string): string | undefined {
  const raw = readIfExists(repoDir, "package.json");
  if (!raw) return undefined;
  try {
    const name = (JSON.parse(raw) as { name?: string }).name?.replace(/^@[^/]+\//, "").trim();
    if (!name || GENERIC_PACKAGE_NAME.test(name)) return undefined;
    return name
      .split(/[-_.\s]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Logos and icons

const DARK_BG_VARIANT = /(?:white|light|inverse|inverted|reverse|reversed|negative|on[-_]?dark|for[-_]?dark|dark)/i;

function listImages(repoDir: string, relDir: string): string[] {
  const dir = join(repoDir, relDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
      .map((e) => join(relDir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function baseName(rel: string): string {
  return rel.split(/[\\/]/).pop() ?? rel;
}

function findLogos(repoDir: string): { logo?: string; logoDark?: string } {
  const dirs = ["public", ...["images", "img", "assets", "brand", "logos", "logo", "static"].map((d) => join("public", d))];
  const all = dirs.flatMap((d) => listImages(repoDir, d)).filter((f) => /logo|wordmark/i.test(baseName(f)) && !/\.ico$/i.test(f));
  const real = all.filter((f) => !/placeholder|example|sample/i.test(baseName(f)));
  const pool = real.length > 0 ? real : all;
  const isSvg = (f: string) => /\.svg$/i.test(f);
  const byScore = (score: (f: string) => number) => (a: string, b: string) =>
    score(a) - score(b) || a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b);

  const light = pool.filter((f) => !DARK_BG_VARIANT.test(baseName(f)));
  const darkBg = pool.filter((f) => DARK_BG_VARIANT.test(baseName(f)));

  const mainScore = (f: string) => {
    const n = baseName(f);
    const kind = /main|primary|full|default/i.test(n) ? 0 : /colou?r/i.test(n) ? 1 : /black|mono|flat|icon|mark|small/i.test(n) ? 3 : 2;
    return kind * 2 + (isSvg(f) ? 0 : 1);
  };
  const darkScore = (f: string) => {
    const n = baseName(f);
    const kind = /white/i.test(n) ? 0 : /inverse|inverted|reverse|negative|on[-_]?dark|for[-_]?dark/i.test(n) ? 1 : /light/i.test(n) ? 2 : 3;
    return kind * 2 + (isSvg(f) ? 0 : 1);
  };

  return {
    logo: [...light].sort(byScore(mainScore))[0],
    logoDark: [...darkBg].sort(byScore(darkScore))[0],
  };
}

/** create-next-app's default `app/favicon.ico` (the Next.js mark) — not the app's own icon. */
const NEXT_DEFAULT_FAVICON_BYTES = 25931;

function findIcon(repoDir: string): string | undefined {
  const appDirs = ["app", join("src", "app")];
  const candidates = [
    ...appDirs.map((d) => join(d, "icon.svg")),
    join("public", "icon.svg"),
    join("public", "favicon.svg"),
    join("public", "apple-touch-icon.png"),
    ...appDirs.map((d) => join(d, "apple-icon.png")),
    ...appDirs.map((d) => join(d, "icon.png")),
    join("public", "icon.png"),
    join("public", "android-chrome-192x192.png"),
    join("public", "android-chrome-512x512.png"),
    join("public", "icon-192.png"),
    join("public", "icon-512.png"),
    join("public", "favicon-32x32.png"),
    join("public", "favicon.png"),
    join("public", "favicon.ico"),
    ...appDirs.map((d) => join(d, "favicon.ico")),
  ];
  for (const rel of candidates) {
    const file = join(repoDir, rel);
    if (!existsSync(file)) continue;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size === 0) continue;
      if (/favicon\.ico$/.test(rel) && rel.startsWith(join("app")) && st.size === NEXT_DEFAULT_FAVICON_BYTES) continue;
      if (rel.startsWith(join("src", "app")) && /favicon\.ico$/.test(rel) && st.size === NEXT_DEFAULT_FAVICON_BYTES) continue;
    } catch {
      continue;
    }
    return rel;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------

function emptyToUndefined(c: BrandColors | undefined): BrandColors | undefined {
  if (!c) return undefined;
  const entries = Object.entries(c).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as BrandColors) : undefined;
}

/**
 * Detects a repo's brand, read-only: name, colours (light + dark), radius, font (+ stylesheet
 * URL), logo, dark-background logo and icon. Asset paths are relative to `repoDir`. Field order
 * is fixed so a written config is stable.
 */
export function extractBrand(repoDir: string): BrandConfig {
  const css = firstExisting(repoDir, CSS_CANDIDATES);
  const fromCss: CssBrand = css ? brandFromCss(css.content) : { colors: {} };
  const layout = firstExisting(repoDir, LAYOUT_CANDIDATES);

  // Name
  const name = (layout && titleFromLayout(layout.content)) ?? nameFromManifest(repoDir) ?? nameFromPackageJson(repoDir);

  // Colours
  const colors: BrandColors = { ...fromCss.colors };
  const tw = firstExisting(repoDir, TAILWIND_CONFIG_CANDIDATES);
  if (!colors.primary && tw) colors.primary = primaryFromTailwindConfig(tw.content);
  const { primary, accent, ...rest } = colors;

  // Fonts
  const twFonts = tw ? fontsFromTailwindConfig(tw.content) : {};
  const linkUrl = layout ? googleLinkHref(layout.content) : undefined;
  let fontUrl = fromCss.fontImportUrl ?? linkUrl;
  const urlFamilies = fontUrl ? familiesFromGoogleFontsUrl(fontUrl) : [];
  const nextFamilies = layout ? nextFontGoogleFamilies(layout.content) : [];
  const nextSans = nextFamilies.find((f) => !/mono|code/i.test(f)) ?? nextFamilies[0];
  const declared = [fromCss.fontVar, fromCss.bodyFont, twFonts.sans, twFonts.other].filter((f): f is string => !!f);

  let font: string | undefined;
  if (urlFamilies.length > 0) {
    font = declared.find((d) => urlFamilies.some((u) => u.toLowerCase() === d.toLowerCase())) ?? urlFamilies[0];
  } else {
    font = nextSans ?? declared[0];
  }
  const headingFont = [fromCss.headingVar, twFonts.heading].find((f) => !!f && f.toLowerCase() !== font?.toLowerCase());
  if (!fontUrl && font) {
    const isGoogle = (f: string) => isGoogleFont(f) || nextFamilies.some((n) => n.toLowerCase() === f.toLowerCase());
    const families = [font, headingFont].filter((f): f is string => !!f && isGoogle(f));
    if (families.length > 0) fontUrl = googleFontsUrl(families);
  }

  const { logo, logoDark } = findLogos(repoDir);
  const icon = findIcon(repoDir);

  const brand: BrandConfig = {
    name,
    primaryColor: primary,
    accentColor: accent,
    colors: emptyToUndefined(rest),
    dark: emptyToUndefined(fromCss.dark),
    logo,
    logoDark,
    icon,
    font,
    fontUrl,
    headingFont,
    radius: fromCss.radius,
  };
  return Object.fromEntries(Object.entries(brand).filter(([, v]) => v !== undefined)) as BrandConfig;
}

/**
 * `extractBrand()`'s asset paths (relative to the app repo) re-expressed relative to `configDir`
 * — the convention `aida.config`'s brand.logo/logoDark/icon use. Always forward slashes.
 */
export function rebaseBrandPaths(brand: BrandConfig, repoDir: string, configDir: string): BrandConfig {
  const out: BrandConfig = { ...brand };
  for (const key of ["logo", "logoDark", "icon"] as const) {
    const p = brand[key];
    if (!p || isAbsolute(p)) continue;
    out[key] = relative(configDir, resolve(repoDir, p)).split(sep).join("/");
  }
  return out;
}
